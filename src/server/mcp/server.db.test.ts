import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { count } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import { createProduct, createService, createShop } from "../../../test/fixtures";
import { createFakePayPal } from "../../../test/paypal-fake";
import type { Db } from "../db/client";
import { orders } from "../db/schema";
import {
  DEMO_PRODUCT_ID,
  DEMO_SERVICE_ID,
  DEMO_SHOP_ID,
  DEMO_TECHNICIAN_IDS,
  seedDemoData,
} from "../db/seed";
import { createPayPalProvider } from "../paypal/orders";
import { createCallerCounter } from "./caller-limits";
import { createMcpServer } from "./server";

const getDb = setupMigratedDatabase();
const idempotencyKey = "3f0c9c58-6f6d-4e2b-9a57-0f4f7f0f1a11";

let client: Client;
let paypal: ReturnType<typeof createFakePayPal>;

beforeEach(async () => {
  vi.stubEnv("APP_ORIGIN", "https://shop.example");
  paypal = createFakePayPal();
  const paypalFor = createPayPalProvider(
    {
      PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP: "test-client-id",
      PAYPAL_CLIENT_SECRET_DEMO_PHONE_WORKSHOP: "test-client-secret",
    },
    paypal.adapter,
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(getDb(), { paypalFor }).connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
});

afterEach(async () => {
  await client.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

const textOf = (result: ToolResult) =>
  (result.content as { type: string; text: string }[])[0].text;

const errorCode = (result: ToolResult) => {
  expect(result.isError).toBe(true);
  return (JSON.parse(textOf(result)) as { code: string }).code;
};

const call = (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });

describe("booking a repair", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const range = () => ({
    from: new Date(Date.now() + DAY_MS).toISOString(),
    to: new Date(Date.now() + 8 * DAY_MS).toISOString(),
  });

  const seedWithMerchant = () =>
    seedDemoData(getDb(), {
      DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID: "SEEDEDMERCHANT1",
    });

  const firstSlot = async () => {
    const result = await call("get_slots", {
      shopId: DEMO_SHOP_ID,
      serviceId: DEMO_SERVICE_ID,
      ...range(),
    });
    expect(result.isError).toBeFalsy();
    const { slots } = result.structuredContent as {
      slots: { slotId: string; technicianId: string; timezone: string }[];
    };
    return slots[0];
  };

  it("finds a slot, holds it and reports the booking and the money", async () => {
    await seedWithMerchant();
    const slot = await firstSlot();
    expect(DEMO_TECHNICIAN_IDS).toContain(slot.technicianId);
    expect(slot.timezone).toBe("Europe/Riga");

    const args = {
      slotId: slot.slotId,
      serviceId: DEMO_SERVICE_ID,
      idempotencyKey,
    };
    const booked = await call("book_slot", args);
    expect(booked.isError).toBeFalsy();
    const held = booked.structuredContent as {
      bookingId: string;
      orderId: string;
      statusToken: string;
      approvalUrl: string;
      depositMinor: number;
      remainingMinor: number;
    };
    expect(held).toMatchObject({ depositMinor: 2000, remainingMinor: 6000 });
    expect(held.approvalUrl).toContain("sandbox.paypal.com");

    const repeat = await call("book_slot", args);
    expect(repeat.structuredContent).toEqual(held);
    expect(paypal.createRequests()).toHaveLength(1);

    const status = await call("get_order_status", {
      orderId: held.orderId,
      statusToken: held.statusToken,
    });
    expect(status.structuredContent).toMatchObject({
      paymentStatus: "pending",
      totalMinor: 2000,
      booking: {
        bookingId: held.bookingId,
        status: "held",
        reviewReason: null,
        depositMinor: 2000,
        remainingMinor: 6000,
      },
    });

    // The slot is gone for this technician, and another buyer is told so.
    expect((await firstSlot()).slotId).not.toBe(slot.slotId);
    expect(
      errorCode(
        await call("book_slot", {
          ...args,
          idempotencyKey: "7c1a2f7e-4f7b-4a9c-9a41-0f4f7f0f1a12",
        }),
      ),
    ).toBe("SLOT_UNAVAILABLE");
  });

  it("limits new holds per caller, and still answers a retry of one it made", async () => {
    await seedWithMerchant();
    const paypalFor = createPayPalProvider(
      {
        PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP: "test-client-id",
        PAYPAL_CLIENT_SECRET_DEMO_PHONE_WORKSHOP: "test-client-secret",
      },
      paypal.adapter,
    );
    const newHold = createCallerCounter(1);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(
      getDb(),
      { paypalFor },
      { newHold: () => newHold("one caller"), recordSearch: () => true },
    ).connect(serverSide);
    const limited = new Client({ name: "test", version: "0.0.0" });
    await limited.connect(clientSide);
    const hold = async (key: string) =>
      limited.callTool({
        name: "book_slot",
        arguments: {
          slotId: (await firstSlot()).slotId,
          serviceId: DEMO_SERVICE_ID,
          idempotencyKey: key,
        },
      });

    const slot = await firstSlot();
    const args = { slotId: slot.slotId, serviceId: DEMO_SERVICE_ID, idempotencyKey };
    const first = await limited.callTool({ name: "book_slot", arguments: args });
    expect(first.isError).toBeFalsy();
    const repeat = await limited.callTool({ name: "book_slot", arguments: args });
    expect(repeat.structuredContent).toEqual(first.structuredContent);

    const refused = await hold("7c1a2f7e-4f7b-4a9c-9a41-0f4f7f0f1a12");
    expect(errorCode(refused)).toBe("HOLD_LIMIT_REACHED");
    expect(paypal.createRequests()).toHaveLength(1);
    await expect(getDb().select({ value: count() }).from(orders)).resolves.toEqual([{ value: 1 }]);
    await limited.close();
  });

  it("answers a shop with no PayPal set up with a stable code", async () => {
    await seedDemoData(getDb(), {});
    const slot = await firstSlot();
    expect(
      errorCode(
        await call("book_slot", {
          slotId: slot.slotId,
          serviceId: DEMO_SERVICE_ID,
          idempotencyKey,
        }),
      ),
    ).toBe("PAYMENT_NOT_CONFIGURED");
  });

  it("refuses a client deposit, and a range longer than a month", async () => {
    await seedWithMerchant();
    const slot = await firstSlot();
    const tampered = await call("book_slot", {
      slotId: slot.slotId,
      serviceId: DEMO_SERVICE_ID,
      idempotencyKey,
      depositMinor: 1,
    });
    expect(tampered.isError).toBe(true);
    const tooLong = await call("get_slots", {
      shopId: DEMO_SHOP_ID,
      serviceId: DEMO_SERVICE_ID,
      from: new Date().toISOString(),
      to: new Date(Date.now() + 40 * DAY_MS).toISOString(),
    });
    expect(tooLong.isError).toBe(true);
  });
});

describe("a tool that fails unexpectedly", () => {
  it("logs no query parameters and tells the client nothing was charged", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new DrizzleQueryError("insert into orders values ($1)", ["PRIVATEMERCHANT"], new Error("down"));
    const brokenDb = new Proxy(
      {},
      {
        get() {
          throw failure;
        },
      },
    ) as Db;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(brokenDb).connect(serverSide);
    const broken = new Client({ name: "test", version: "0.0.0" });
    await broken.connect(clientSide);

    const result = await broken.callTool({ name: "get_slots", arguments: {
      shopId: DEMO_SHOP_ID,
      serviceId: DEMO_SERVICE_ID,
      from: new Date(Date.now() + 86_400_000).toISOString(),
      to: new Date(Date.now() + 172_800_000).toISOString(),
    } });
    await broken.close();

    expect(errorCode(result)).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(log.mock.calls)).toContain("MCP tool failed");
    expect(log.mock.calls.flat().some((value) => value === failure)).toBe(false);
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATEMERCHANT");
  });
});

describe("tools/list", () => {
  it("offers the implemented tools and marks reads and writes", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    expect(Object.keys(byName).sort()).toEqual([
      "book_slot",
      "create_checkout",
      "get_order_status",
      "get_slots",
      "search_products",
    ]);
    expect(byName.get_slots.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.book_slot.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(byName.search_products.annotations).toMatchObject({
      readOnlyHint: true,
    });
    expect(byName.get_order_status.annotations).toMatchObject({
      readOnlyHint: true,
    });
    expect(byName.create_checkout.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  it("publishes strict schemas with no merchant fields", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ additionalProperties: false });
      expect(tool.outputSchema).toBeDefined();
    }
    expect(JSON.stringify(tools)).not.toMatch(/merchant|payee|credential/i);
    const checkout = tools.find((tool) => tool.name === "create_checkout");
    expect(Object.keys(checkout?.inputSchema.properties ?? {}).sort()).toEqual([
      "idempotencyKey",
      "items",
    ]);
  });
});

describe("search_products", () => {
  it("finds the seeded product as structured and text content", async () => {
    await seedDemoData(getDb(), {});
    const result = await call("search_products", {
      query: "iPhone 13 screen protector",
      location: "Liepāja",
      maxPriceMinor: 1500,
      currency: "EUR",
    });

    expect(result.isError).toBeFalsy();
    const { products } = result.structuredContent as {
      products: Record<string, unknown>[];
    };
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      productId: DEMO_PRODUCT_ID,
      shopId: DEMO_SHOP_ID,
      kind: "product",
      priceMinor: 990,
      currency: "EUR",
      availability: "available",
    });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it("leaves out unpublished products and private data", async () => {
    const shop = await createShop(getDb(), {
      paypalMerchantId: "PRIVATE-MERCHANT",
    });
    await createProduct(getDb(), shop.id, {
      title: "Hidden cable",
      status: "draft",
    });
    await createProduct(getDb(), shop.id, { title: "Visible cable" });

    const result = await call("search_products", { query: "cable" });
    const { products } = result.structuredContent as {
      products: { title: string }[];
    };
    expect(products.map((product) => product.title)).toEqual(["Visible cable"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });

  it("takes a kind filter, and tells a client when matching is degraded", async () => {
    await seedDemoData(getDb(), {});
    const result = await call("search_products", {
      query: "iPhone 13 screen",
      kind: "service",
    });
    const { products, matching } = result.structuredContent as {
      products: { kind: string }[];
      matching: { mode: string; notice: string };
    };
    expect(products.map((product) => product.kind)).toEqual(["service"]);
    expect(matching.mode).toBe("degraded");
    expect(matching.notice).toMatch(/does not prove|no result/);
  });

  it("answers a search with no match as an empty result, not an error", async () => {
    const result = await call("search_products", { query: "MagSafe charger" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      products: [],
      matching: { mode: "full", notice: null },
    });
  });

  it.each([
    ["a missing query", {}, "query"],
    ["an empty query", { query: "" }, "query"],
    ["a fractional price", { query: "x", maxPriceMinor: 1.5 }, "maxPriceMinor"],
    ["a limit over the bound", { query: "x", limit: 21 }, "limit"],
    ["an unknown field", { query: "x", shopCredential: "y" }, "shopCredential"],
  ])("rejects %s and names the field", async (_name, args, field) => {
    const result = await call("search_products", args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(field);
  });
});

describe("create_checkout", () => {
  const seededCart = {
    items: [{ productId: DEMO_PRODUCT_ID, quantity: 1 }],
    idempotencyKey,
  };

  it("returns the approval link from the shared service, as structured and text content", async () => {
    await seedDemoData(getDb(), {
      DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID: "SANDBOXMERCHANT",
    });
    const result = await call("create_checkout", seededCart);

    expect(result.isError).toBeFalsy();
    const [order] = await getDb().select().from(orders);
    expect(result.structuredContent).toEqual({
      orderId: order.id,
      totalMinor: 990,
      currency: "EUR",
      approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${order.paypalOrderId}`,
      statusToken: expect.any(String),
    });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
    expect(order.paymentStatus).toBe("pending");
    expect(JSON.stringify(result)).not.toMatch(/SANDBOXMERCHANT|DEMO_PHONE_WORKSHOP/);
  });

  it("returns the same order when a client retries the same key", async () => {
    await seedDemoData(getDb(), {
      DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID: "SANDBOXMERCHANT",
    });

    const first = await call("create_checkout", seededCart);
    const second = await call("create_checkout", seededCart);

    expect(second.structuredContent).toEqual(first.structuredContent);
    expect(paypal.createRequests()).toHaveLength(1);
  });

  it("tells the client to retry with the same key after PayPal times out", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await seedDemoData(getDb(), {
      DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID: "SANDBOXMERCHANT",
    });
    paypal.nextOrder({ type: "timeout", orderCreated: true });

    const result = await call("create_checkout", seededCart);

    expect(errorCode(result)).toBe("PAYMENT_TIMEOUT");
    expect(textOf(result)).toMatch(/same idempotencyKey/);
    expect(result.structuredContent).toBeUndefined();
    expect(textOf(result)).not.toMatch(/paypal\.com|SANDBOXMERCHANT/);
  });

  it("creates nothing when the shop has no PayPal credentials", async () => {
    const shop = await createShop(getDb(), { paypalCredentialRef: "NOT_CONFIGURED" });
    const product = await createProduct(getDb(), shop.id);

    const result = await call("create_checkout", {
      items: [{ productId: product.id, quantity: 1 }],
      idempotencyKey,
    });

    expect(errorCode(result)).toBe("PAYMENT_NOT_CONFIGURED");
    expect(await getDb().select({ n: count() }).from(orders)).toEqual([{ n: 0 }]);
    expect(paypal.requests).toHaveLength(0);
  });

  it("runs the shared cart rules before anything else", async () => {
    const shopA = await createShop(getDb());
    const shopB = await createShop(getDb());
    const productA = await createProduct(getDb(), shopA.id);
    const productB = await createProduct(getDb(), shopB.id);
    const service = await createService(getDb(), shopA.id);
    const unconfigured = await createShop(getDb(), { paypalMerchantId: null });
    const productC = await createProduct(getDb(), unconfigured.id);

    const cases: [string, { productId: string; quantity: number }[]][] = [
      [
        "MIXED_SHOPS",
        [
          { productId: productA.id, quantity: 1 },
          { productId: productB.id, quantity: 1 },
        ],
      ],
      ["PRODUCT_REQUIRES_BOOKING", [{ productId: service.id, quantity: 1 }]],
      ["PAYMENT_NOT_CONFIGURED", [{ productId: productC.id, quantity: 1 }]],
      [
        "PRODUCT_NOT_FOUND",
        [{ productId: "99999999-9999-4999-8999-999999999999", quantity: 1 }],
      ],
    ];
    for (const [code, items] of cases) {
      const result = await call("create_checkout", { items, idempotencyKey });
      expect(errorCode(result)).toBe(code);
    }
  });

  it.each([
    ["a client total", { ...seededCart, totalMinor: 1 }, "totalMinor"],
    ["a client recipient", { ...seededCart, payeeMerchantId: "X" }, "payee"],
    [
      "a client price",
      {
        ...seededCart,
        items: [{ productId: DEMO_PRODUCT_ID, quantity: 1, priceMinor: 1 }],
      },
      "priceMinor",
    ],
    ["a short key", { ...seededCart, idempotencyKey: "short" }, "idempotencyKey"],
    [
      "a zero quantity",
      { ...seededCart, items: [{ productId: DEMO_PRODUCT_ID, quantity: 0 }] },
      "quantity",
    ],
  ])("rejects %s and names the field", async (_name, args, field) => {
    const result = await call("create_checkout", args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(field);
  });
});

describe("get_order_status", () => {
  const seededCart = {
    items: [{ productId: DEMO_PRODUCT_ID, quantity: 1 }],
    idempotencyKey,
  };

  it("reads an order with the capability create_checkout returned", async () => {
    await seedDemoData(getDb(), {
      DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID: "SANDBOXMERCHANT",
    });
    const created = await call("create_checkout", seededCart);
    const { orderId, statusToken } = created.structuredContent as {
      orderId: string;
      statusToken: string;
    };

    const result = await call("get_order_status", { orderId, statusToken });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      orderId,
      paymentStatus: "pending",
      totalMinor: 990,
      currency: "EUR",
      booking: null,
      updatedAt: expect.any(String),
    });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
    expect(JSON.stringify(result)).not.toMatch(/SANDBOXMERCHANT|paypal\.com/);
  });

  it("refuses an order identifier without its capability", async () => {
    await seedDemoData(getDb(), {
      DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID: "SANDBOXMERCHANT",
    });
    const created = await call("create_checkout", seededCart);
    const { orderId } = created.structuredContent as { orderId: string };

    const wrong = await call("get_order_status", {
      orderId,
      statusToken: "x".repeat(43),
    });
    const missing = await call("get_order_status", { orderId });

    expect(errorCode(wrong)).toBe("ORDER_STATUS_UNAVAILABLE");
    expect(textOf(wrong)).not.toContain(orderId);
    expect(wrong.structuredContent).toBeUndefined();
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("statusToken");
  });
});
