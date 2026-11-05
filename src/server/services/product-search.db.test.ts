import { describe, expect, it } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import { createProduct, createService, createShop } from "../../../test/fixtures";
import { searchProductsResult } from "../contracts/commerce";
import { DEMO_PRODUCT_ID, DEMO_SHOP_ID, seedDemoData } from "../db/seed";
import { searchProducts } from "./catalog";

const getDb = setupMigratedDatabase();

const titles = async (input: Record<string, unknown>) =>
  (await searchProducts(getDb(), input)).products.map((p) => p.title);

describe("searchProducts", () => {
  it("finds the seeded product with its authoritative price and shop", async () => {
    await seedDemoData(getDb(), {});
    const { products } = await searchProducts(getDb(), {
      query: "iPhone 13 screen protector",
    });
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
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
    await createProduct(getDb(), shop.id, { title: "Cable" });

    const result = await searchProducts(getDb(), { query: "cable" });
    expect(() => searchProductsResult.parse(result)).not.toThrow();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|scrypt/);
  });

  it("searches across shops", async () => {
    const shopA = await createShop(getDb());
    const shopB = await createShop(getDb());
    await createProduct(getDb(), shopA.id, { title: "Blue cable" });
    await createProduct(getDb(), shopB.id, { title: "Red cable" });
    expect((await titles({ query: "cable" })).sort()).toEqual([
      "Blue cable",
      "Red cable",
    ]);
  });

  it.each(["draft", "unpublished"] as const)(
    "never returns a %s product",
    async (status) => {
      const shop = await createShop(getDb());
      await createProduct(getDb(), shop.id, { title: "Hidden cable", status });
      expect(await titles({ query: "cable" })).toEqual([]);
    },
  );

  it("needs every meaningful word to match", async () => {
    const shop = await createShop(getDb());
    await createProduct(getDb(), shop.id, { title: "iPhone 13 glass" });
    expect(await titles({ query: "glass for iPhone 13" })).toEqual([
      "iPhone 13 glass",
    ]);
    expect(await titles({ query: "MagSafe charger" })).toEqual([]);
  });

  it("matches the description, the shop name and the shop location", async () => {
    const shop = await createShop(getDb(), {
      name: "Harbour Repairs",
      location: "Ventspils",
    });
    await createProduct(getDb(), shop.id, {
      title: "Cable",
      description: "Braided nylon",
    });
    for (const query of ["braided", "harbour", "ventspils"]) {
      expect(await titles({ query })).toEqual(["Cable"]);
    }
  });

  it("treats Latvian letters and their plain forms as the same", async () => {
    const plain = await createShop(getDb(), { location: "Liepaja" });
    const accented = await createShop(getDb(), { location: "Rēzekne" });
    await createProduct(getDb(), plain.id, { title: "Plain cable" });
    await createProduct(getDb(), accented.id, { title: "Accented cable" });

    expect(await titles({ query: "cable", location: "Liepāja" })).toEqual([
      "Plain cable",
    ]);
    expect(await titles({ query: "cable", location: "Rezekne" })).toEqual([
      "Accented cable",
    ]);
  });

  it("keeps other alphabets intact", async () => {
    const shop = await createShop(getDb());
    await createProduct(getDb(), shop.id, { title: "Чехол для айфона" });
    expect(await titles({ query: "айфона" })).toEqual(["Чехол для айфона"]);
  });

  it.each(["%", "_", "%%%", "!!!"])(
    "does not let %j match everything",
    async (query) => {
      const shop = await createShop(getDb());
      await createProduct(getDb(), shop.id, { title: "Cable" });
      expect(await titles({ query })).toEqual([]);
    },
  );

  it("filters by location", async () => {
    const riga = await createShop(getDb(), { location: "Riga" });
    const liepaja = await createShop(getDb(), { location: "Liepaja" });
    await createProduct(getDb(), riga.id, { title: "Riga cable" });
    await createProduct(getDb(), liepaja.id, { title: "Liepaja cable" });
    expect(await titles({ query: "cable", location: "riga" })).toEqual([
      "Riga cable",
    ]);
    expect(await titles({ query: "cable", location: "%" })).toEqual([]);
  });

  it("never returns an over-budget item", async () => {
    const shop = await createShop(getDb());
    await createProduct(getDb(), shop.id, {
      title: "Cheap cable",
      priceMinor: 1500,
    });
    await createProduct(getDb(), shop.id, {
      title: "Costly cable",
      priceMinor: 1501,
    });
    expect(await titles({ query: "cable", maxPriceMinor: 1500 })).toEqual([
      "Cheap cable",
    ]);
  });

  it("filters by currency", async () => {
    const eur = await createShop(getDb(), { currency: "EUR" });
    const usd = await createShop(getDb(), { currency: "USD" });
    await createProduct(getDb(), eur.id, { title: "Euro cable" });
    await createProduct(getDb(), usd.id, { title: "Dollar cable" });
    expect(await titles({ query: "cable", currency: "EUR" })).toEqual([
      "Euro cable",
    ]);
  });

  it("orders results the same way every time and applies the limit", async () => {
    const shop = await createShop(getDb());
    await createProduct(getDb(), shop.id, {
      title: "Gone cable",
      priceMinor: 100,
      availability: "unavailable",
    });
    await createProduct(getDb(), shop.id, {
      title: "Adapter",
      description: "With a cable",
      priceMinor: 200,
    });
    await createProduct(getDb(), shop.id, {
      title: "Costly cable",
      priceMinor: 900,
    });
    await createProduct(getDb(), shop.id, {
      title: "Cheap cable",
      priceMinor: 300,
    });

    const expected = ["Cheap cable", "Costly cable", "Adapter", "Gone cable"];
    expect(await titles({ query: "cable" })).toEqual(expected);
    expect(await titles({ query: "cable", limit: 2 })).toEqual(
      expected.slice(0, 2),
    );
  });

  it("includes services with their terms", async () => {
    const shop = await createShop(getDb());
    await createService(getDb(), shop.id, { title: "Screen repair" });
    const { products } = await searchProducts(getDb(), { query: "repair" });
    expect(products[0]).toMatchObject({
      kind: "service",
      serviceDurationMinutes: 60,
      depositMinor: 2000,
    });
  });

  it("rejects malformed input", async () => {
    for (const input of [{}, { query: "" }, { query: "x", limit: 21 }]) {
      await expect(searchProducts(getDb(), input)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }
  });
});
