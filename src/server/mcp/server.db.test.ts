import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { count } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import { createProduct, createService, createShop } from "../../../test/fixtures";
import { orders } from "../db/schema";
import { DEMO_PRODUCT_ID, DEMO_SHOP_ID, seedDemoData } from "../db/seed";
import { createMcpServer } from "./server";

const getDb = setupMigratedDatabase();
const idempotencyKey = "3f0c9c58-6f6d-4e2b-9a57-0f4f7f0f1a11";

let client: Client;

beforeEach(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(getDb()).connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
});

afterEach(async () => {
  await client.close();
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

describe("tools/list", () => {
  it("offers the implemented tools and marks reads and writes", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    expect(Object.keys(byName).sort()).toEqual([
      "create_checkout",
      "search_products",
    ]);
    expect(byName.search_products.annotations).toMatchObject({
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

  it("answers a search with no match as an empty result, not an error", async () => {
    const result = await call("search_products", { query: "MagSafe charger" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ products: [] });
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

  it("reaches the shared service, which reports payment as unavailable", async () => {
    await seedDemoData(getDb(), {
      DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID: "SANDBOXMERCHANT",
    });
    const result = await call("create_checkout", seededCart);

    expect(errorCode(result)).toBe("PAYMENT_UNAVAILABLE");
    expect(textOf(result)).not.toMatch(/approval|paypal\.com/i);
    expect(result.structuredContent).toBeUndefined();
    expect(await getDb().select({ n: count() }).from(orders)).toEqual([{ n: 0 }]);
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
