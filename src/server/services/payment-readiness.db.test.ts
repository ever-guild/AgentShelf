import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { setupMigratedDatabase } from "../../../test/database";
import { createProduct, createService, createShop, createTrackedProduct, setTestTrackedStock } from "../../../test/fixtures";
import { createFakePayPal } from "../../../test/paypal-fake";
import { createLaterWebhookEvent, createTestConnection } from "../../../test/payment-connections";
import { paypalMerchantConnections } from "../db/schema";
import { ServiceError } from "../errors";
import { createMcpServer } from "../mcp/server";
import { createPayPalProvider, type PayPalProvider } from "../paypal/orders";
import { searchProducts } from "./catalog";
import { createCheckout } from "./checkout";

const getDb = setupMigratedDatabase();

const PLATFORM_ENV = {
  PAYPAL_PLATFORM_CLIENT_ID: "sandbox-platform-client-id",
  PAYPAL_PLATFORM_CLIENT_SECRET: "sandbox-platform-client-secret",
  PAYPAL_PARTNER_ATTRIBUTION_ID: "AGENT_SHELF_BN_CODE",
};
const LEGACY_ENV = {
  PAYPAL_CLIENT_ID_LEGACY: "legacy-id",
  PAYPAL_CLIENT_SECRET_LEGACY: "legacy-secret",
};
const KEY = "3f0c9c58-6f6d-4e2b-9a57-0f4f7f0f1a11";

let paypal: ReturnType<typeof createFakePayPal>;
let paypalFor: PayPalProvider;

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "https://shop.example");
  paypal = createFakePayPal();
  paypalFor = createPayPalProvider({ ...PLATFORM_ENV, ...LEGACY_ENV }, paypal.adapter);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const platformShop = (overrides = {}) =>
  createShop(getDb(), { paypalCredentialRef: "PAYPAL_PLATFORM", paypalMerchantId: null, ...overrides });

const find = async (query: string, provider: PayPalProvider = paypalFor) =>
  (await searchProducts(getDb(), { query }, { paypalFor: provider })).products;

const readinessOf = async (shopId: string, provider: PayPalProvider = paypalFor) => {
  const found = (await find("cable", provider)).filter((product) => product.shopId === shopId);
  expect(found.length).toBeGreaterThan(0);
  const { paymentReady, paymentUnavailableReason } = found[0];
  return { paymentReady, paymentUnavailableReason };
};

const ready = { paymentReady: true, paymentUnavailableReason: null };
const notConnected = { paymentReady: false, paymentUnavailableReason: "not_connected" };
const notReady = { paymentReady: false, paymentUnavailableReason: "not_ready" };

describe("search payment readiness", () => {
  it("reproduces: two equal offers are both available, and only paymentReady tells them apart", async () => {
    const unready = await platformShop({ name: "Unready shop" });
    const readyShop = await platformShop({ name: "Ready shop" });
    await createTestConnection(getDb(), readyShop.id);
    await createTrackedProduct(getDb(), unready.id, { title: "Charger cable" });
    await createTrackedProduct(getDb(), readyShop.id, { title: "Charger cable" });

    const products = await find("charger cable");
    expect(products).toHaveLength(2);
    // Before this change the summary had nothing but availability, and both read the same.
    expect(products.map((product) => product.availability)).toEqual(["available", "available"]);
    const byShop = Object.fromEntries(products.map((product) => [product.shopName, product]));
    expect(byShop["Unready shop"]).toMatchObject(notConnected);
    expect(byShop["Ready shop"]).toMatchObject(ready);
  });

  it("covers every connection state", async () => {
    const cases: [string, () => Promise<{ id: string }>, object, PayPalProvider?][] = [
      ["platform ready", async () => {
        const shop = await platformShop();
        await createTestConnection(getDb(), shop.id);
        return shop;
      }, ready],
      ["pending", async () => {
        const shop = await platformShop();
        await createTestConnection(getDb(), shop.id, { status: "pending" });
        return shop;
      }, notReady],
      ["revoked", async () => {
        const shop = await platformShop();
        await createTestConnection(getDb(), shop.id, { status: "revoked" });
        return shop;
      }, notReady],
      ["evidence mismatch", async () => {
        const shop = await platformShop();
        await createTestConnection(getDb(), shop.id, { evidence: { paymentsReceivable: false } });
        return shop;
      }, notReady],
      ["later webhook event", async () => {
        const shop = await platformShop();
        const { sellerMerchantId } = await createTestConnection(getDb(), shop.id);
        await createLaterWebhookEvent(getDb(), sellerMerchantId);
        return shop;
      }, notReady],
      ["missing server config", async () => {
        const shop = await platformShop();
        await createTestConnection(getDb(), shop.id);
        return shop;
      }, notReady, () => undefined],
      ["unconfigured with no row", () => platformShop({ paypalCredentialRef: "UNCONFIGURED" }), notConnected],
      ["platform with no row", () => platformShop(), notConnected],
      ["legacy with merchant id", () => createShop(getDb(), {
        paypalCredentialRef: "LEGACY", paypalMerchantId: "LEGACYMERCHANT1",
      }), ready],
      ["legacy without merchant id", () => createShop(getDb(), {
        paypalCredentialRef: "LEGACY", paypalMerchantId: null,
      }), notConnected],
    ];
    for (const [label, build, expected, provider] of cases) {
      const shop = await build();
      await createProduct(getDb(), shop.id, { title: "Cable" });
      expect(await readinessOf(shop.id, provider ?? paypalFor), label).toEqual(expected);
    }
  });

  it("legacy shop with missing server config is not ready", async () => {
    const shop = await createShop(getDb(), { paypalCredentialRef: "LEGACY_MISSING", paypalMerchantId: "M123456" });
    await createProduct(getDb(), shop.id, { title: "Cable" });
    expect(await readinessOf(shop.id)).toEqual(notReady);
  });

  it("is independent of availability, stock and kind", async () => {
    const readyShop = await platformShop();
    await createTestConnection(getDb(), readyShop.id);
    const unready = await platformShop();
    const zero = await createProduct(getDb(), readyShop.id, { title: "Zero cable" });
    await setTestTrackedStock(getDb(), readyShop.id, zero.id, 0);
    const noPolicy = await createProduct(getDb(), readyShop.id, { title: "Plain cable" });
    const tracked = await createTrackedProduct(getDb(), unready.id, { title: "Tracked cable" });
    const service = await createService(getDb(), readyShop.id, { title: "Cable repair" });
    const unreadyService = await createService(getDb(), unready.id, { title: "Cable repair" });

    const byId = new Map((await find("cable")).map((product) => [product.productId, product]));
    expect(byId.get(zero.id)).toMatchObject({ availability: "unavailable", ...ready });
    // No stock policy reads as unavailable whatever the payment state.
    expect(byId.get(noPolicy.id)).toMatchObject({ availability: "unavailable", ...ready });
    expect(byId.get(tracked.id)).toMatchObject({ availability: "available", ...notConnected });
    expect(byId.get(service.id)).toMatchObject({ kind: "service", availability: "available", ...ready });
    expect(byId.get(unreadyService.id)).toMatchObject({ kind: "service", availability: "available", ...notConnected });
  });

  it("resolves a shop once for all of its products and keeps shops apart", async () => {
    const readyShop = await platformShop();
    await createTestConnection(getDb(), readyShop.id);
    const other = await platformShop();
    for (const title of ["Cable one", "Cable two", "Cable three"]) {
      await createProduct(getDb(), readyShop.id, { title });
    }
    await createProduct(getDb(), other.id, { title: "Cable four" });

    const spy = vi.fn(paypalFor);
    const products = await find("cable", spy as unknown as PayPalProvider);
    expect(products).toHaveLength(4);
    expect(spy).toHaveBeenCalledTimes(1);
    for (const product of products) {
      expect(product).toMatchObject(product.shopId === readyShop.id ? ready : notConnected);
    }
  });

  it("is a snapshot: a later search sees a revoked connection and create_checkout still refuses", async () => {
    const shop = await platformShop();
    await createTestConnection(getDb(), shop.id);
    const product = await createProduct(getDb(), shop.id, { title: "Cable" });
    await setTestTrackedStock(getDb(), shop.id, product.id, 5);
    expect(await readinessOf(shop.id)).toEqual(ready);

    await getDb().update(paypalMerchantConnections).set({ status: "revoked" })
      .where(eq(paypalMerchantConnections.shopId, shop.id));

    expect(await readinessOf(shop.id)).toEqual(notReady);
    const refused = await createCheckout(
      getDb(),
      { items: [{ productId: product.id, quantity: 1 }], idempotencyKey: KEY },
      { paypalFor },
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ServiceError);
    expect((refused as ServiceError).code).toBe("PAYMENT_NOT_CONFIGURED");
    expect(paypal.requests).toHaveLength(0);
  });
});

describe("search_products over MCP", () => {
  it("returns both fields and leaks no payment identifiers", async () => {
    const shop = await platformShop({ paypalMerchantId: "LEGACYSTALE123" });
    const { sellerMerchantId, trackingId } = await createTestConnection(getDb(), shop.id);
    await createProduct(getDb(), shop.id, { title: "Cable" });
    const other = await createShop(getDb(), {
      paypalCredentialRef: "UNCONFIGURED", paypalMerchantId: null, name: "Other",
    });
    await createProduct(getDb(), other.id, { title: "Cable" });

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(getDb(), { paypalFor }).connect(serverSide);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);
    const result = await client.callTool({ name: "search_products", arguments: { query: "cable" } });
    const { tools } = await client.listTools();
    await client.close();

    expect(result.isError).toBeFalsy();
    const { products } = result.structuredContent as { products: Record<string, unknown>[] };
    expect(products.map((product) => product.paymentReady).sort()).toEqual([false, true]);
    expect(products.find((product) => product.shopId === other.id)).toMatchObject(notConnected);
    const serialized = JSON.stringify(result);
    for (const secret of [sellerMerchantId, trackingId, "LEGACYSTALE123", "PAYPAL_PLATFORM", "UNCONFIGURED", "PAYPAL_PLATFORM_CLIENT"]) {
      expect(serialized).not.toContain(secret);
    }
    const description = tools.find((tool) => tool.name === "search_products")?.description ?? "";
    expect(description).toContain("paymentReady");
    expect(description).toContain("get_slots");
  });
});
