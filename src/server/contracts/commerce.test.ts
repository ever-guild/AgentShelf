import { describe, expect, it } from "vitest";

import {
  createCheckoutInput,
  getOrderStatusInput,
  getOrderStatusResult,
  getSlotsInput,
  ianaTimezone,
  productSummary,
  searchProductsInput,
} from "./commerce";

const PRODUCT_ID = "20000000-0000-4000-8000-000000000001";
const SHOP_ID = "10000000-0000-4000-8000-000000000001";
const ORDER_ID = "30000000-0000-4000-8000-000000000001";
const KEY = "3f0c9c58-6f6d-4e2b-9a57-0f4f7f0f1a11";

const validCheckout = {
  items: [{ productId: PRODUCT_ID, quantity: 2 }],
  idempotencyKey: KEY,
};

describe("create_checkout input", () => {
  it("accepts a product list and a key", () => {
    expect(createCheckoutInput.parse(validCheckout)).toEqual(validCheckout);
  });

  it.each([
    ["a total", { totalMinor: 1 }],
    ["a currency", { currency: "EUR" }],
    ["a merchant", { payeeMerchantId: "ATTACKER" }],
    ["a PayPal payee", { payee: { merchant_id: "ATTACKER" } }],
    ["a shop", { shopId: SHOP_ID }],
  ])("rejects a client-supplied %s", (_name, extra) => {
    expect(createCheckoutInput.safeParse({ ...validCheckout, ...extra }).success)
      .toBe(false);
  });

  it("rejects a client-supplied unit price on an item", () => {
    const items = [{ productId: PRODUCT_ID, quantity: 1, priceMinor: 1 }];
    expect(createCheckoutInput.safeParse({ ...validCheckout, items }).success)
      .toBe(false);
  });

  it.each([0, -1, 1.5, 100, "2", null])("rejects quantity %j", (quantity) => {
    const items = [{ productId: PRODUCT_ID, quantity }];
    expect(createCheckoutInput.safeParse({ ...validCheckout, items }).success)
      .toBe(false);
  });

  it("rejects an empty cart, repeated products and malformed identifiers", () => {
    for (const items of [
      [],
      [
        { productId: PRODUCT_ID, quantity: 1 },
        { productId: PRODUCT_ID, quantity: 1 },
      ],
      [{ productId: "1", quantity: 1 }],
    ]) {
      expect(createCheckoutInput.safeParse({ ...validCheckout, items }).success)
        .toBe(false);
    }
  });

  it("rejects a key short enough to guess", () => {
    expect(
      createCheckoutInput.safeParse({ ...validCheckout, idempotencyKey: "1" })
        .success,
    ).toBe(false);
  });
});

describe("search_products input", () => {
  it("trims the query and applies the default limit", () => {
    expect(searchProductsInput.parse({ query: "  iphone  " })).toEqual({
      query: "iphone",
      limit: 10,
    });
  });

  it.each([
    { query: "" },
    { query: "   " },
    { query: "x".repeat(201) },
    { query: "x", limit: 0 },
    { query: "x", limit: 21 },
    { query: "x", maxPriceMinor: 12.5 },
    { query: "x", maxPriceMinor: -1 },
    { query: "x", currency: "eur" },
    { query: "x", shopCredential: "anything" },
  ])("rejects %j", (input) => {
    expect(searchProductsInput.safeParse(input).success).toBe(false);
  });
});

describe("get_slots input", () => {
  const range = { shopId: SHOP_ID, serviceId: PRODUCT_ID };

  it("accepts explicit instants with an offset", () => {
    expect(
      getSlotsInput.safeParse({
        ...range,
        from: "2026-11-10T08:00:00+02:00",
        to: "2026-11-10T18:00:00+02:00",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["an inverted range", "2026-11-10T18:00:00Z", "2026-11-10T08:00:00Z"],
    ["a range over 31 days", "2026-11-01T00:00:00Z", "2026-12-03T00:00:00Z"],
    ["an instant with no offset", "2026-11-10T08:00:00", "2026-11-10T18:00:00"],
  ])("rejects %s", (_name, from, to) => {
    expect(getSlotsInput.safeParse({ ...range, from, to }).success).toBe(false);
  });
});

describe("order status contract", () => {
  it("cannot be read with an order identifier alone", () => {
    expect(getOrderStatusInput.safeParse({ orderId: ORDER_ID }).success).toBe(
      false,
    );
  });

  it("has no room for payer data in its result", () => {
    const status = {
      orderId: ORDER_ID,
      paymentStatus: "pending",
      totalMinor: 990,
      currency: "EUR",
      booking: null,
      updatedAt: "2026-11-10T08:00:00Z",
    };
    expect(getOrderStatusResult.safeParse(status).success).toBe(true);
    expect(
      getOrderStatusResult.safeParse({ ...status, payerEmail: "a@example.com" })
        .success,
    ).toBe(false);
  });
});

describe("product summary", () => {
  it("has no room for credentials or merchant identifiers", () => {
    const summary = {
      productId: PRODUCT_ID,
      shopId: SHOP_ID,
      shopName: "Demo",
      location: "Liepaja",
      kind: "product",
      title: "Cable",
      description: "",
      priceMinor: 990,
      currency: "EUR",
      availability: "available",
      serviceDurationMinutes: null,
      depositMinor: null,
    };
    expect(productSummary.safeParse(summary).success).toBe(true);
    for (const leak of ["paypalMerchantId", "paypalCredentialRef"]) {
      expect(productSummary.safeParse({ ...summary, [leak]: "x" }).success).toBe(
        false,
      );
    }
  });
});

describe("IANA timezones", () => {
  it.each(["Europe/Riga", "America/Argentina/Buenos_Aires", "UTC"])(
    "accepts %s",
    (timezone) => {
      expect(ianaTimezone.safeParse(timezone).success).toBe(true);
    },
  );

  it.each(["Mars/Olympus", "+02:00", "EET", "riga", ""])(
    "rejects %j",
    (timezone) => {
      expect(ianaTimezone.safeParse(timezone).success).toBe(false);
    },
  );
});
