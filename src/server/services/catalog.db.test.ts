import { describe, expect, it } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import { createProduct, createShop } from "../../../test/fixtures";
import { productSummary } from "../contracts/commerce";
import { DEMO_PRODUCT_ID, DEMO_SHOP_ID, seedDemoData } from "../db/seed";
import { getPublishedProduct, listPublishedProducts } from "./catalog";

const getDb = setupMigratedDatabase();

describe("getPublishedProduct", () => {
  it("reads the seeded product with its authoritative price", async () => {
    await seedDemoData(getDb(), {});
    const product = await getPublishedProduct(getDb(), {
      shopId: DEMO_SHOP_ID,
      productId: DEMO_PRODUCT_ID,
    });
    expect(product).toMatchObject({
      productId: DEMO_PRODUCT_ID,
      shopId: DEMO_SHOP_ID,
      kind: "product",
      priceMinor: 990,
      currency: "EUR",
      availability: "available",
    });
  });

  it("returns only the public contract, with no credential or merchant data", async () => {
    const shop = await createShop(getDb(), {
      paypalMerchantId: "PRIVATE-MERCHANT",
      paypalCredentialRef: "PRIVATE_REF",
      sellerAccessCodeHash: "scrypt$private$private",
    });
    const product = await createProduct(getDb(), shop.id);
    const summary = await getPublishedProduct(getDb(), {
      shopId: shop.id,
      productId: product.id,
    });

    expect(() => productSummary.parse(summary)).not.toThrow();
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("PRIVATE");
    expect(serialized).not.toContain("scrypt");
  });

  it("rejects a malformed shop reference", async () => {
    await expect(
      getPublishedProduct(getDb(), {
        shopId: "not-a-uuid",
        productId: DEMO_PRODUCT_ID,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects a shop that does not exist", async () => {
    await seedDemoData(getDb(), {});
    await expect(
      getPublishedProduct(getDb(), {
        shopId: "99999999-9999-4999-8999-999999999999",
        productId: DEMO_PRODUCT_ID,
      }),
    ).rejects.toMatchObject({ code: "SHOP_NOT_FOUND" });
  });

  it("does not return another shop's product", async () => {
    const owner = await createShop(getDb());
    const other = await createShop(getDb());
    const product = await createProduct(getDb(), owner.id);
    await expect(
      getPublishedProduct(getDb(), { shopId: other.id, productId: product.id }),
    ).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
  });

  it.each(["draft", "unpublished"] as const)(
    "does not return a %s product",
    async (status) => {
      const shop = await createShop(getDb());
      const product = await createProduct(getDb(), shop.id, { status });
      await expect(
        getPublishedProduct(getDb(), { shopId: shop.id, productId: product.id }),
      ).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
    },
  );
});

describe("listPublishedProducts", () => {
  it("lists only this shop's published products", async () => {
    const shop = await createShop(getDb());
    const other = await createShop(getDb());
    const visible = await createProduct(getDb(), shop.id);
    await createProduct(getDb(), shop.id, { status: "draft", priceMinor: null });
    await createProduct(getDb(), other.id);

    const listed = await listPublishedProducts(getDb(), { shopId: shop.id });
    expect(listed.map((product) => product.productId)).toEqual([visible.id]);
  });

  it("rejects an invalid shop reference", async () => {
    await expect(
      listPublishedProducts(getDb(), { shopId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      listPublishedProducts(getDb(), {
        shopId: "99999999-9999-4999-8999-999999999999",
      }),
    ).rejects.toMatchObject({ code: "SHOP_NOT_FOUND" });
  });
});
