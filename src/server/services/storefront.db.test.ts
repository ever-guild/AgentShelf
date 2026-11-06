import { randomUUID } from "node:crypto";

import { count, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import { createProduct, createService, createShop } from "../../../test/fixtures";
import {
  CLIENT_SECRET,
  MERCHANT_ID,
  createPaymentHarness,
  readOrder,
  type PaymentHarness,
} from "../../../test/payments";
import { orders, products } from "../db/schema";
import { ServiceError } from "../errors";
import { createCheckout } from "./checkout";
import { reconcileForBuyer } from "./payment-reconciliation";
import {
  chooseDescription,
  createStorefrontCheckout,
  getBuyerOrder,
  getStorefront,
  getStorefrontProduct,
  storefrontCheckoutResponse,
} from "./storefront";

const getDb = setupMigratedDatabase();
const CREDENTIAL_REF = "TEST_SHOP";

let harness: PaymentHarness;

async function orderCount() {
  const [row] = await getDb().select({ value: count() }).from(orders);
  return row.value;
}

async function codeOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (thrown) => thrown,
  );
  expect(error).toBeInstanceOf(ServiceError);
  return (error as ServiceError).code;
}

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "https://shop.example");
  harness = createPaymentHarness();
});

async function shopWithProduct(priceMinor = 990) {
  const shop = await createShop(getDb(), { paypalMerchantId: MERCHANT_ID });
  const product = await createProduct(getDb(), shop.id, { priceMinor });
  return { shop, product };
}

function buy(slug: string, productId: string, idempotencyKey = randomUUID()) {
  return createStorefrontCheckout(getDb(), slug, { productId, idempotencyKey }, harness.deps);
}

// Goes through the same calls as a buyer's browser and the return route.
function capabilityOf(returnPath: string) {
  const query = new URL(returnPath, "https://shop.example").searchParams;
  return { orderId: query.get("order"), statusToken: query.get("status") };
}

describe("getStorefront", () => {
  it("lists only what this shop has published, with the fields a page shows", async () => {
    const db = getDb();
    const shop = await createShop(db, { name: "Workshop", location: "Liepaja" });
    const other = await createShop(db);
    await createProduct(db, shop.id, { title: "On sale", description: "Good", priceMinor: 1250 });
    await createProduct(db, shop.id, { title: "Sold out", availability: "unavailable" });
    await createService(db, shop.id, { title: "Repair" });
    await createProduct(db, shop.id, { title: "Draft", status: "draft" });
    await createProduct(db, shop.id, { title: "Withdrawn", status: "unpublished" });
    await createProduct(db, other.id, { title: "Elsewhere" });

    const page = await getStorefront(db, shop.slug, "en", harness.deps.paypalFor);

    expect(page.shop).toEqual({ slug: shop.slug, name: "Workshop", location: "Liepaja" });
    expect(page.products.map((product) => product.title)).toEqual([
      "On sale",
      "Repair",
      "Sold out",
    ]);
    expect(page.products[0]).toEqual({
      id: expect.any(String),
      kind: "product",
      title: "On sale",
      description: "Good",
      descriptionLanguage: null,
      priceMinor: 1250,
      currency: "EUR",
      availability: "available",
      serviceDurationMinutes: null,
      depositMinor: null,
    });
  });

  it("gives a page nothing it could leak: no merchant, credential reference or secret", async () => {
    const db = getDb();
    const shop = await createShop(db, { paypalMerchantId: MERCHANT_ID });
    await createProduct(db, shop.id, { paypalProductId: "PROD-SECRET" });

    const seen = JSON.stringify([
      await getStorefront(db, shop.slug, "en", harness.deps.paypalFor),
      await getStorefrontProduct(
        db,
        shop.slug,
        (await getStorefront(db, shop.slug, "en", harness.deps.paypalFor)).products[0].id,
        "en",
        harness.deps.paypalFor,
      ),
    ]);

    for (const secret of [MERCHANT_ID, CREDENTIAL_REF, CLIENT_SECRET, "PROD-SECRET", shop.id]) {
      expect(seen).not.toContain(secret);
    }
  });

  it("answers the same for an unknown slug and a malformed one", async () => {
    const db = getDb();
    await expect(codeOf(getStorefront(db, "no-such-shop"))).resolves.toBe("SHOP_NOT_FOUND");
    await expect(codeOf(getStorefront(db, "bad\u0000slug"))).resolves.toBe("SHOP_NOT_FOUND");
  });

  it("says a shop takes payment only with both a merchant and a configured app", async () => {
    const db = getDb();
    const { paypalFor } = harness.deps;
    const ready = await createShop(db, { paypalMerchantId: MERCHANT_ID });
    const noMerchant = await createShop(db, { paypalMerchantId: null });
    const noApp = await createShop(db, { paypalCredentialRef: "NOT_CONFIGURED" });

    const accepts = async (slug: string) =>
      (await getStorefront(db, slug, "en", paypalFor)).acceptsPayment;
    await expect(accepts(ready.slug)).resolves.toBe(true);
    await expect(accepts(noMerchant.slug)).resolves.toBe(false);
    await expect(accepts(noApp.slug)).resolves.toBe(false);
  });

  it("still lists products with no PayPal credentials at all", async () => {
    const db = getDb();
    const shop = await createShop(db);
    await createProduct(db, shop.id, { title: "Still listed" });

    const page = await getStorefront(db, shop.slug, "en", () => undefined);
    expect(page.acceptsPayment).toBe(false);
    expect(page.products.map((product) => product.title)).toEqual(["Still listed"]);
  });
});

describe("chooseDescription", () => {
  const texts = { description: "Source", descriptionEn: "English", descriptionLv: "Latviski" };

  it("shows reviewed text in the language asked for", () => {
    expect(chooseDescription(texts, "lv")).toEqual({ text: "Latviski", language: "lv" });
    expect(chooseDescription(texts, "en")).toEqual({ text: "English", language: "en" });
  });

  it("falls back without inventing anything, and treats blank text as missing", () => {
    expect(chooseDescription({ ...texts, descriptionLv: "  " }, "lv")).toEqual({
      text: "English",
      language: "en",
    });
    expect(chooseDescription({ description: "Source" }, "lv")).toEqual({
      text: "Source",
      language: null,
    });
  });
});

describe("getStorefrontProduct", () => {
  it("hands the browser the public client ID only when the shop can take payment", async () => {
    const db = getDb();
    const { paypalFor } = harness.deps;
    const { shop, product } = await shopWithProduct();
    const page = await getStorefrontProduct(db, shop.slug, product.id, "en", paypalFor);
    expect(page.paypalClientId).toBe("test-client-id");

    const unpaid = await createShop(db, { paypalMerchantId: null });
    const listed = await createProduct(db, unpaid.id);
    const closed = await getStorefrontProduct(db, unpaid.slug, listed.id, "en", paypalFor);
    expect(closed.paypalClientId).toBeNull();
  });

  it("does not show a draft, another shop's product or a malformed identifier", async () => {
    const db = getDb();
    const { shop } = await shopWithProduct();
    const other = await createShop(db);
    const elsewhere = await createProduct(db, other.id);
    const draft = await createProduct(db, shop.id, { status: "draft" });

    for (const id of [elsewhere.id, draft.id, "not-a-uuid", randomUUID()]) {
      await expect(codeOf(getStorefrontProduct(db, shop.slug, id))).resolves.toBe(
        "PRODUCT_NOT_FOUND",
      );
    }
  });
});

describe("createStorefrontCheckout", () => {
  it("creates the order MCP would: stored total, the shop as recipient, nothing charged", async () => {
    const { shop, product } = await shopWithProduct(1234);

    const checkout = await buy(shop.slug, product.id);

    expect(checkout.totalMinor).toBe(1234);
    expect(checkout.currency).toBe("EUR");
    expect(checkout.approvalUrl).toBe(
      `https://www.sandbox.paypal.com/checkoutnow?token=${checkout.paypalOrderId}`,
    );
    const [request] = harness.paypal.createRequests();
    const [unit] = harness.paypal.bodyOf(request).purchase_units;
    expect(unit.payee).toEqual({ merchant_id: MERCHANT_ID });
    expect(unit.amount.value).toBe("12.34");
    expect(harness.paypal.charges()).toBe(0);

    const stored = await readOrder(getDb(), capabilityOf(checkout.returnPath).orderId as string);
    expect(stored.paymentStatus).toBe("pending");
    expect(stored.shopId).toBe(shop.id);
    expect(stored.payeeMerchantId).toBe(MERCHANT_ID);
  });

  it("refuses a tampered request before anything is stored or sent", async () => {
    const { shop, product } = await shopWithProduct();
    const valid = { productId: product.id, idempotencyKey: randomUUID() };

    for (const extra of [
      { priceMinor: 1 },
      { totalMinor: 1 },
      { currency: "USD" },
      { merchantId: "ATTACKER" },
      { payee: { merchant_id: "ATTACKER" } },
      { shopId: randomUUID() },
      { quantity: 50 },
      { items: [{ productId: product.id, quantity: 1 }] },
    ]) {
      await expect(
        codeOf(createStorefrontCheckout(getDb(), shop.slug, { ...valid, ...extra }, harness.deps)),
      ).resolves.toBe("INVALID_INPUT");
    }
    await expect(orderCount()).resolves.toBe(0);
    expect(harness.paypal.requests).toHaveLength(0);
  });

  it("refuses a browser key that is not a UUID", async () => {
    const { shop, product } = await shopWithProduct();
    for (const idempotencyKey of [
      "short",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "storefront:7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "../../etc/passwd/../../etc/passwd",
      42,
      undefined,
    ]) {
      await expect(
        codeOf(
          createStorefrontCheckout(
            getDb(),
            shop.slug,
            { productId: product.id, idempotencyKey },
            harness.deps,
          ),
        ),
      ).resolves.toBe("INVALID_INPUT");
    }
    await expect(orderCount()).resolves.toBe(0);
  });

  it("refuses another shop's product on this shop's address, as if it did not exist", async () => {
    const { shop } = await shopWithProduct();
    const other = await createShop(getDb(), { paypalMerchantId: "OTHERMERCHANT1" });
    const elsewhere = await createProduct(getDb(), other.id);

    await expect(codeOf(buy(shop.slug, elsewhere.id))).resolves.toBe("PRODUCT_NOT_FOUND");
    await expect(codeOf(buy(shop.slug, randomUUID()))).resolves.toBe("PRODUCT_NOT_FOUND");
    await expect(codeOf(buy("no-such-shop", elsewhere.id))).resolves.toBe("SHOP_NOT_FOUND");
    await expect(orderCount()).resolves.toBe(0);
  });

  it("applies MCP's rules for what can be sold", async () => {
    const db = getDb();
    const { shop } = await shopWithProduct();
    const draft = await createProduct(db, shop.id, { status: "draft" });
    const withdrawn = await createProduct(db, shop.id, { status: "unpublished" });
    const soldOut = await createProduct(db, shop.id, { availability: "unavailable" });
    const service = await createService(db, shop.id);

    await expect(codeOf(buy(shop.slug, draft.id))).resolves.toBe("PRODUCT_NOT_FOUND");
    await expect(codeOf(buy(shop.slug, withdrawn.id))).resolves.toBe("PRODUCT_NOT_FOUND");
    await expect(codeOf(buy(shop.slug, soldOut.id))).resolves.toBe("PRODUCT_UNAVAILABLE");
    await expect(codeOf(buy(shop.slug, service.id))).resolves.toBe("PRODUCT_REQUIRES_BOOKING");
    await expect(orderCount()).resolves.toBe(0);
  });

  it("says payment is not configured and stores nothing without a merchant or an app", async () => {
    const db = getDb();
    const noMerchant = await createShop(db, { paypalMerchantId: null });
    const noApp = await createShop(db, {
      paypalMerchantId: "NOAPPMERCHANT1",
      paypalCredentialRef: "NOT_CONFIGURED",
    });
    for (const shop of [noMerchant, noApp]) {
      const product = await createProduct(db, shop.id);
      await expect(codeOf(buy(shop.slug, product.id))).resolves.toBe("PAYMENT_NOT_CONFIGURED");
    }
    await expect(orderCount()).resolves.toBe(0);
  });

  it("answers a repeated key with the same order, whatever the price has become", async () => {
    const { shop, product } = await shopWithProduct(990);
    const key = randomUUID();
    const first = await buy(shop.slug, product.id, key);

    await getDb().update(products).set({ priceMinor: 5000 }).where(eq(products.id, product.id));
    const repeat = await buy(shop.slug, product.id, key);

    expect(repeat).toEqual(first);
    expect(harness.paypal.createRequests()).toHaveLength(1);
  });

  it("uses the new price for a new key", async () => {
    const { shop, product } = await shopWithProduct(990);
    await getDb().update(products).set({ priceMinor: 5000 }).where(eq(products.id, product.id));
    await expect(buy(shop.slug, product.id)).resolves.toMatchObject({ totalMinor: 5000 });
  });

  it("cannot reach an order made through another channel by reusing its key", async () => {
    const { shop, product } = await shopWithProduct();
    const key = randomUUID();
    const agent = await createCheckout(
      getDb(),
      { items: [{ productId: product.id, quantity: 1 }], idempotencyKey: key },
      harness.deps,
    );

    const browser = await buy(shop.slug, product.id, key);

    expect(capabilityOf(browser.returnPath).orderId).not.toBe(agent.orderId);
    expect(browser.returnPath).not.toContain(agent.statusToken);
    await expect(orderCount()).resolves.toBe(2);
  });
});

describe("what a buyer sees after PayPal", () => {
  async function placed() {
    const { shop, product } = await shopWithProduct(990);
    const checkout = await buy(shop.slug, product.id);
    return { shop, product, checkout, capability: capabilityOf(checkout.returnPath) };
  }
  const settle = (capability: unknown, options = {}) =>
    reconcileForBuyer(getDb(), capability, harness.deps, options);

  it("is not paid before the server has verified the capture", async () => {
    const { shop, capability, checkout } = await placed();

    await expect(getBuyerOrder(getDb(), capability)).resolves.toMatchObject({
      paymentStatus: "pending",
      shop: { slug: shop.slug, name: shop.name },
      lines: [{ title: "Test cable", quantity: 1 }],
    });

    // Coming back to the return link without approving charges nothing and shows nothing as paid.
    await settle(capability);
    await expect(getBuyerOrder(getDb(), capability)).resolves.toMatchObject({
      paymentStatus: "pending",
    });
    expect(harness.paypal.captureRequests()).toHaveLength(0);

    harness.paypal.approve(checkout.paypalOrderId);
    await expect(getBuyerOrder(getDb(), capability)).resolves.toMatchObject({
      paymentStatus: "pending",
    });
    await settle(capability);
    await expect(getBuyerOrder(getDb(), capability)).resolves.toMatchObject({
      paymentStatus: "paid",
      totalMinor: 990,
    });
    expect(harness.paypal.charges()).toBe(1);
  });

  it("shows a cancellation and keeps the shop", async () => {
    const { shop, capability } = await placed();
    await settle(capability, { buyerCancelled: true });
    await expect(getBuyerOrder(getDb(), capability)).resolves.toMatchObject({
      paymentStatus: "cancelled",
      shop: { slug: shop.slug },
    });
    expect(harness.paypal.charges()).toBe(0);
  });

  it("shows a delayed capture as still confirming, never as paid", async () => {
    const { capability, checkout } = await placed();
    harness.paypal.approve(checkout.paypalOrderId);
    harness.paypal.nextCapture({ type: "capture_status", status: "PENDING" });
    await settle(capability);
    await expect(getBuyerOrder(getDb(), capability)).resolves.toMatchObject({
      paymentStatus: "approved",
    });
  });

  it("shows a declined capture as failed", async () => {
    const { capability, checkout } = await placed();
    harness.paypal.approve(checkout.paypalOrderId);
    harness.paypal.nextCapture({ type: "capture_status", status: "DECLINED" });
    await settle(capability);
    await expect(getBuyerOrder(getDb(), capability)).resolves.toMatchObject({
      paymentStatus: "failed",
    });
  });

  it("shows nothing without the order's capability", async () => {
    const { shop, product, capability } = await placed();
    const other = capabilityOf((await buy(shop.slug, product.id)).returnPath);
    for (const input of [
      { orderId: capability.orderId, statusToken: other.statusToken },
      { orderId: capability.orderId, statusToken: "x".repeat(40) },
      { orderId: capability.orderId },
      {},
    ]) {
      const code = await codeOf(getBuyerOrder(getDb(), input));
      expect(["ORDER_STATUS_UNAVAILABLE", "INVALID_INPUT"]).toContain(code);
    }
  });

  it("holds no recipient or credential detail", async () => {
    const { capability } = await placed();
    const seen = JSON.stringify(await getBuyerOrder(getDb(), capability));
    expect(seen).not.toContain(MERCHANT_ID);
    expect(seen).not.toContain(CREDENTIAL_REF);
  });
});

describe("storefrontCheckoutResponse", () => {
  const post = (body: string, contentType = "application/json") =>
    new Request("https://shop.example/api/shops/x/checkout", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    });

  it("answers with an order and tells caches to keep out of it", async () => {
    const { shop, product } = await shopWithProduct();
    const response = await storefrontCheckoutResponse(
      post(JSON.stringify({ productId: product.id, idempotencyKey: randomUUID() })),
      shop.slug,
      getDb(),
      harness.deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ totalMinor: 990 });
  });

  it("gives a tampered request a 400 that names the field and echoes no value", async () => {
    const { shop, product } = await shopWithProduct();
    const response = await storefrontCheckoutResponse(
      post(
        JSON.stringify({
          productId: product.id,
          idempotencyKey: randomUUID(),
          priceMinor: 12345,
        }),
      ),
      shop.slug,
      getDb(),
      harness.deps,
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("INVALID_INPUT");
    expect(text).not.toContain("12345");
  });

  it("refuses what is not a small JSON request", async () => {
    const { shop, product } = await shopWithProduct();
    const valid = JSON.stringify({ productId: product.id, idempotencyKey: randomUUID() });
    for (const request of [
      post("{not json"),
      post(valid, "text/plain"),
      post(`${valid}${" ".repeat(5000)}`),
    ]) {
      const response = await storefrontCheckoutResponse(
        request,
        shop.slug,
        getDb(),
        harness.deps,
      );
      expect(response.status).toBe(400);
    }
    await expect(orderCount()).resolves.toBe(0);
  });
});
