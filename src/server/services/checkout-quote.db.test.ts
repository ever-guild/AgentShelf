import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import {
  createProduct,
  createService,
  createShop,
} from "../../../test/fixtures";
import { products } from "../db/schema";
import { MAX_MINOR } from "../domain/money";
import { quoteCheckout } from "./checkout-quote";

const getDb = setupMigratedDatabase();

const idempotencyKey = "3f0c9c58-6f6d-4e2b-9a57-0f4f7f0f1a11";
const cart = (...items: { productId: string; quantity: number }[]) => ({
  items,
  idempotencyKey,
});

describe("quoteCheckout", () => {
  it("computes the total and recipient from stored data", async () => {
    const shop = await createShop(getDb(), {
      paypalMerchantId: "STORED-MERCHANT",
      paypalCredentialRef: "STORED_REF",
    });
    const glass = await createProduct(getDb(), shop.id, { priceMinor: 990 });
    const cable = await createProduct(getDb(), shop.id, {
      title: "Cable",
      priceMinor: 450,
    });

    const quote = await quoteCheckout(
      getDb(),
      cart(
        { productId: glass.id, quantity: 3 },
        { productId: cable.id, quantity: 1 },
      ),
    );

    expect(quote).toMatchObject({
      shopId: shop.id,
      currency: "EUR",
      totalMinor: 3420,
      payeeMerchantId: "STORED-MERCHANT",
      paypalCredentialRef: "STORED_REF",
    });
    expect(quote.lines).toContainEqual({
      productId: glass.id,
      title: "Test cable",
      unitPriceMinor: 990,
      quantity: 3,
      lineTotalMinor: 2970,
    });
  });

  it("rejects a tampered total or recipient instead of ignoring it", async () => {
    const shop = await createShop(getDb());
    const product = await createProduct(getDb(), shop.id);
    const valid = cart({ productId: product.id, quantity: 1 });

    for (const tampered of [
      { ...valid, totalMinor: 1 },
      { ...valid, payeeMerchantId: "ATTACKER" },
      {
        ...valid,
        items: [{ productId: product.id, quantity: 1, priceMinor: 1 }],
      },
    ]) {
      await expect(quoteCheckout(getDb(), tampered)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }
  });

  it("uses the current price for a later checkout", async () => {
    const shop = await createShop(getDb());
    const product = await createProduct(getDb(), shop.id, { priceMinor: 990 });
    await getDb()
      .update(products)
      .set({ priceMinor: 1250 })
      .where(eq(products.id, product.id));

    const quote = await quoteCheckout(
      getDb(),
      cart({ productId: product.id, quantity: 2 }),
    );
    expect(quote.totalMinor).toBe(2500);
  });

  it("rejects products from two shops", async () => {
    const shopA = await createShop(getDb());
    const shopB = await createShop(getDb());
    const productA = await createProduct(getDb(), shopA.id);
    const productB = await createProduct(getDb(), shopB.id);

    await expect(
      quoteCheckout(
        getDb(),
        cart(
          { productId: productA.id, quantity: 1 },
          { productId: productB.id, quantity: 1 },
        ),
      ),
    ).rejects.toMatchObject({ code: "MIXED_SHOPS" });
  });

  it.each(["draft", "unpublished"] as const)(
    "rejects a %s product",
    async (status) => {
      const shop = await createShop(getDb());
      const product = await createProduct(getDb(), shop.id, { status });
      await expect(
        quoteCheckout(getDb(), cart({ productId: product.id, quantity: 1 })),
      ).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
    },
  );

  it("rejects an unknown product", async () => {
    await expect(
      quoteCheckout(
        getDb(),
        cart({
          productId: "99999999-9999-4999-8999-999999999999",
          quantity: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
  });

  it("rejects an unavailable product", async () => {
    const shop = await createShop(getDb());
    const product = await createProduct(getDb(), shop.id, {
      availability: "unavailable",
    });
    await expect(
      quoteCheckout(getDb(), cart({ productId: product.id, quantity: 1 })),
    ).rejects.toMatchObject({ code: "PRODUCT_UNAVAILABLE" });
  });

  it("sends a service through booking rather than checkout", async () => {
    const shop = await createShop(getDb());
    const service = await createService(getDb(), shop.id);
    await expect(
      quoteCheckout(getDb(), cart({ productId: service.id, quantity: 1 })),
    ).rejects.toMatchObject({ code: "PRODUCT_REQUIRES_BOOKING" });
  });

  it("rejects an unsupported currency", async () => {
    const shop = await createShop(getDb(), { currency: "USD" });
    const product = await createProduct(getDb(), shop.id);
    await expect(
      quoteCheckout(getDb(), cart({ productId: product.id, quantity: 1 })),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CURRENCY" });
  });

  it("stops before PayPal when a shop has no merchant account", async () => {
    const shop = await createShop(getDb(), { paypalMerchantId: null });
    const product = await createProduct(getDb(), shop.id);
    await expect(
      quoteCheckout(getDb(), cart({ productId: product.id, quantity: 1 })),
    ).rejects.toMatchObject({ code: "PAYMENT_NOT_CONFIGURED" });
  });

  it("rejects a total the database could not store", async () => {
    const shop = await createShop(getDb());
    const product = await createProduct(getDb(), shop.id, {
      priceMinor: MAX_MINOR,
    });
    await expect(
      quoteCheckout(getDb(), cart({ productId: product.id, quantity: 2 })),
    ).rejects.toMatchObject({ code: "AMOUNT_OUT_OF_RANGE" });
  });
});
