import { asc, desc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import { createProduct, createService, createShop } from "../../../test/fixtures";
import { createFakeSearchAi } from "../../../test/search";
import { searchProductsResult } from "../contracts/commerce";
import { searchEvents } from "../db/schema";
import { DEMO_CHARGER_ID, DEMO_PRODUCT_ID, DEMO_SERVICE_ID, DEMO_SHOP_ID, seedDemoData } from "../db/seed";
import { searchProducts } from "./catalog";
import { runSearchIndexing } from "./search-index";

// A small fixed relevance set: positive, empty, cross-shop, location and price cases, each with the
// exact IDs it must return and the event it must leave. The terms are written down here so the set
// checks matching and not a model. docs/architecture.md has the results of a real indexing run.

const getDb = setupMigratedDatabase();

const REPAIR_TERMS = {
  english: ["cracked screen", "display replacement", "broken screen"],
  latvian: ["ekrāna remonts", "ekrāna maiņa", "saplīsis ekrāns"],
  russian: ["ремонт экрана", "замена экрана", "разбитый экран"],
};

const TERMS = {
  "iPhone 13 screen replacement": {
    ...REPAIR_TERMS,
    places: ["Liepāja", "Liepājā", "Лиепая", "Лиепае"],
  },
  "iPhone 13 screen repair, same day": {
    ...REPAIR_TERMS,
    places: ["Rēzekne", "Резекне"],
  },
  "USB-C wall charger": {
    english: ["phone charger", "power adapter"],
    latvian: ["lādētājs"],
    russian: ["зарядное устройство", "зарядка"],
  },
};

let ids: {
  repairB: string;
  caseB: string;
  premiumB: string;
  draftA: string;
  foodC: string;
  shopB: string;
  shopC: string;
};

beforeEach(async () => {
  await seedDemoData(getDb(), {});
  const shopB = await createShop(getDb(), { name: "Daugava Mobile", location: "Rēzekne" });
  const shopC = await createShop(getDb(), { name: "Harbour Pets", location: "Ventspils" });
  const repairB = await createService(getDb(), shopB.id, {
    title: "iPhone 13 screen repair, same day",
    priceMinor: 9500,
  });
  const caseB = await createProduct(getDb(), shopB.id, {
    title: "iPhone 13 silicone case",
    priceMinor: 1200,
  });
  const premiumB = await createProduct(getDb(), shopB.id, {
    title: "iPhone 13 premium screen protector",
    priceMinor: 1990,
  });
  const draftA = await createProduct(getDb(), DEMO_SHOP_ID, {
    title: "iPhone 13 privacy screen protector",
    priceMinor: 100,
    status: "draft",
  });
  const foodC = await createProduct(getDb(), shopC.id, { title: "Cat food", priceMinor: 750 });
  ids = {
    repairB: repairB.id,
    caseB: caseB.id,
    premiumB: premiumB.id,
    draftA: draftA.id,
    foodC: foodC.id,
    shopB: shopB.id,
    shopC: shopC.id,
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  await runSearchIndexing(getDb(), createFakeSearchAi(TERMS).ai);
});

const idsFor = async (input: Record<string, unknown>) => {
  const result = await searchProducts(getDb(), input);
  expect(() => searchProductsResult.parse(result)).not.toThrow();
  expect(result.matching.mode).toBe("full");
  return result.products.map((product) => product.productId);
};

// The seed's labeled fixtures are not searches made by these tests.
const lastEvents = () =>
  getDb().select().from(searchEvents).where(eq(searchEvents.origin, "observed")).orderBy(desc(searchEvents.createdAt), asc(searchEvents.id));

describe("positive", () => {
  it.each([
    ["the acceptance query, with a filter", { query: "iPhone 13 screen repair", location: "Liepaja" }],
    ["the accented city", { query: "iPhone 13 screen repair", location: "Liepāja" }],
    ["the city in the query", { query: "iPhone 13 screen repair in Liepaja" }],
    ["the accented city in the query", { query: "iPhone 13 screen repair in Liepājā" }],
    ["an inflected city", { query: "iPhone 13 screen repair", location: "Liepājas" }],
    ["Russian", { query: "ремонт экрана iPhone 13 в Лиепае" }],
    ["Latvian", { query: "iPhone 13 ekrāna remonts Liepājā" }],
    ["Latvian with no accents", { query: "iphone 13 ekrana remonts liepaja" }],
    ["a synonym", { query: "broken screen iPhone 13", location: "Liepaja" }],
    ["run-together model", { query: "iPhone13 screen repair", location: "Liepaja" }],
    ["a plural", { query: "iPhone 13 screen repairs", location: "Liepaja" }],
    ["an inflected Russian word", { query: "замена разбитого экрана iPhone 13 Лиепая" }],
    ["words buyers add", { query: "I need a screen repair for my iPhone 13 please", location: "Liepaja" }],
  ])("%s finds the seeded service", async (_name, input) => {
    expect(await idsFor(input)).toEqual([DEMO_SERVICE_ID]);
  });

  it("returns the seeded service with its shop and price", async () => {
    const { products } = await searchProducts(getDb(), {
      query: "iPhone 13 screen repair",
      location: "Liepāja",
    });
    expect(products[0]).toMatchObject({
      productId: DEMO_SERVICE_ID,
      shopId: DEMO_SHOP_ID,
      shopName: "Demo Phone Workshop",
      location: "Liepaja",
      kind: "service",
      priceMinor: 8000,
      currency: "EUR",
      depositMinor: 2000,
      serviceDurationMinutes: 60,
    });
  });

  it("never near-matches a model number", async () => {
    // Named, because a fixture's random name could hold the number this looks for.
    const shop = await createShop(getDb(), { name: "Galaxy Corner" });
    await createProduct(getDb(), shop.id, { title: "Galaxy S21 case" });
    await createProduct(getDb(), shop.id, { title: "Model 12345" });
    await runSearchIndexing(getDb(), createFakeSearchAi(TERMS).ai);
    expect(await idsFor({ query: "Galaxy S22 case" })).toEqual([]);
    expect(await idsFor({ query: "Model 123456" })).toEqual([]);
    expect(await idsFor({ query: "iPhone 1 screen repair" })).toEqual([]);
    expect(await idsFor({ query: "iPhone 14 screen repair" })).toEqual([]);
  });

  it("finds an accessory by its Russian name", async () => {
    expect(await idsFor({ query: "зарядка" })).toEqual([DEMO_CHARGER_ID]);
    expect(await idsFor({ query: "lādētājs" })).toEqual([DEMO_CHARGER_ID]);
  });

  it("records what it returned, and attributes nothing", async () => {
    await idsFor({ query: "iPhone 13 screen repair!", location: "Liepāja", maxPriceMinor: 9000, currency: "EUR", kind: "service" });
    const events = await lastEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      queryNormalized: "iphone 13 screen repair",
      location: "liepaja",
      maxPriceMinor: 9000,
      currency: "EUR",
      kind: "service",
      resultCount: 1,
      matchedProductIds: [DEMO_SERVICE_ID],
      attributedShopId: null,
      attributionWords: [],
      degraded: false,
      origin: "observed",
    });
  });
});

describe("cross-shop", () => {
  it("ranks the same service across shops by price, and stays stable", async () => {
    const expected = [DEMO_SERVICE_ID, ids.repairB];
    const input = { query: "iPhone 13 screen", kind: "service" };
    expect(await idsFor(input)).toEqual(expected);
    expect(await idsFor(input)).toEqual(expected);
  });

  it("finds both shops' repairs, with the one that says so in its title first", async () => {
    expect(await idsFor({ query: "iPhone 13 screen repair" })).toEqual([
      ids.repairB,
      DEMO_SERVICE_ID,
    ]);
  });

  it("ranks a title match above one that only shares the description", async () => {
    const shop = await createShop(getDb());
    const inTitle = await createProduct(getDb(), shop.id, {
      title: "Repair kit",
      priceMinor: 5000,
    });
    const inDescription = await createProduct(getDb(), shop.id, {
      title: "Toolbox",
      description: "A repair repair repair repair kit, repair repair",
      priceMinor: 100,
    });
    await runSearchIndexing(getDb(), createFakeSearchAi(TERMS).ai);
    const found = await idsFor({ query: "repair kit" });
    expect(found.indexOf(inTitle.id)).toBeLessThan(found.indexOf(inDescription.id));
  });

  it("finds every shop's item for one word", async () => {
    expect((await idsFor({ query: "iPhone 13" })).sort()).toEqual(
      [DEMO_PRODUCT_ID, DEMO_SERVICE_ID, ids.repairB, ids.caseB, ids.premiumB].sort(),
    );
  });
});

describe("location", () => {
  it.each([
    ["Rēzekne"],
    ["Rezekne"],
    ["rezekne"],
  ])("%s finds only that shop's service", async (location) => {
    expect(await idsFor({ query: "iPhone 13 screen repair", location })).toEqual([ids.repairB]);
  });

  it("a shop's name does not answer a location filter", async () => {
    const shop = await createShop(getDb(), { name: "Riga Repairs", location: "Ventspils" });
    await createProduct(getDb(), shop.id, { title: "Tripod" });
    await runSearchIndexing(getDb(), createFakeSearchAi(TERMS).ai);
    expect(await idsFor({ query: "tripod", location: "Riga" })).toEqual([]);
  });
});

describe("price and kind", () => {
  it("a limit keeps out what costs more and what is not published", async () => {
    expect(await idsFor({ query: "iPhone 13 screen protector", maxPriceMinor: 1500 })).toEqual([
      DEMO_PRODUCT_ID,
    ]);
    expect(await idsFor({ query: "iPhone 13 screen protector", maxPriceMinor: 1990 })).toEqual([
      DEMO_PRODUCT_ID,
      ids.premiumB,
    ]);
    expect(await idsFor({ query: "iPhone 13 screen protector", maxPriceMinor: 989 })).toEqual([]);
  });

  it("never returns the draft at any price", async () => {
    expect(await idsFor({ query: "privacy screen protector" })).toEqual([]);
    const seen = await idsFor({ query: "iPhone 13" });
    expect(seen).not.toContain(ids.draftA);
  });

  it("filters by kind", async () => {
    expect(await idsFor({ query: "iPhone 13 screen", kind: "service", limit: 20 })).toEqual([
      DEMO_SERVICE_ID,
      ids.repairB,
    ]);
    expect(await idsFor({ query: "iPhone 13 screen", kind: "product", limit: 20 })).toEqual([
      DEMO_PRODUCT_ID,
      ids.premiumB,
    ]);
  });
});

describe("empty, and who it belongs to", () => {
  it("a MagSafe charger miss belongs to the shop that sells chargers", async () => {
    expect(await idsFor({ query: "MagSafe charger" })).toEqual([]);
    const events = await lastEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      queryNormalized: "magsafe charger",
      resultCount: 0,
      matchedProductIds: [],
      attributedShopId: DEMO_SHOP_ID,
      attributionWords: ["charger"],
      attributionProductIds: [DEMO_CHARGER_ID],
      degraded: false,
    });
  });

  it.each([
    ["with the city as a filter", { query: "MagSafe charger", location: "Liepāja" }],
    ["with the city in the query", { query: "MagSafe charger in Liepāja" }],
    ["in Russian", { query: "MagSafe зарядка" }],
    ["as a plural", { query: "MagSafe chargers" }],
  ])("the same holds %s", async (_name, input) => {
    expect(await idsFor(input)).toEqual([]);
    const [event] = await lastEvents();
    expect(event.attributedShopId).toBe(DEMO_SHOP_ID);
    expect(event.attributionProductIds).toEqual([DEMO_CHARGER_ID]);
  });

  it.each([
    ["nobody sells anything like it", { query: "horse saddle" }],
    ["only the place overlaps", { query: "horse saddle in Liepaja" }],
    ["less than half overlaps", { query: "red horse charger saddle" }],
    ["the query only names the shop's place", { query: "Liepaja", maxPriceMinor: 1 }],
    ["the shop is elsewhere, by filter", { query: "MagSafe charger", location: "Riga" }],
    ["the shop is elsewhere, in words", { query: "MagSafe charger in Riga" }],
    ["the shop sells in another currency", { query: "MagSafe charger", currency: "USD" }],
    ["the shop has no such kind", { query: "MagSafe charger", kind: "service" }],
  ])("is a global miss when %s", async (_name, input) => {
    expect(await idsFor(input)).toEqual([]);
    const events = await lastEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      resultCount: 0,
      attributedShopId: null,
      attributionWords: [],
      attributionProductIds: [],
    });
  });

  it("an over-budget miss belongs to the shops that sell it above the budget", async () => {
    expect(await idsFor({ query: "screen protector", maxPriceMinor: 500 })).toEqual([]);
    const events = await lastEvents();
    expect(events.map((event) => event.attributedShopId).sort()).toEqual(
      [DEMO_SHOP_ID, ids.shopB].sort(),
    );
    expect(new Set(events.map((event) => event.searchId)).size).toBe(1);
    for (const event of events) {
      expect(event.attributionWords).toEqual(["screen", "protector"]);
      expect(event.maxPriceMinor).toBe(500);
    }
  });

  it("names at most five shops and five listings per shop for one miss", async () => {
    for (let index = 0; index < 6; index += 1) {
      const shop = await createShop(getDb());
      for (let item = 0; item < 6; item += 1) {
        await createProduct(getDb(), shop.id, { title: `Bridle ${item}` });
      }
    }
    // Six shops take two passes, at five requests a pass.
    await runSearchIndexing(getDb(), createFakeSearchAi(TERMS).ai);
    await runSearchIndexing(getDb(), createFakeSearchAi(TERMS).ai);
    await idsFor({ query: "leather bridle" });
    const events = await lastEvents();
    expect(events).toHaveLength(5);
    for (const event of events) {
      expect(event.attributionProductIds).toHaveLength(5);
    }
  });

  it("does not credit a draft or an unpublished listing as a reason to attribute", async () => {
    const shop = await createShop(getDb());
    await createProduct(getDb(), shop.id, { title: "Hidden saddle", status: "draft" });
    await createProduct(getDb(), shop.id, { title: "Withdrawn saddle", status: "unpublished" });
    await idsFor({ query: "horse saddle" });
    expect((await lastEvents())[0].attributedShopId).toBeNull();
  });

  it("does not mix one shop's basis into another's", async () => {
    await idsFor({ query: "screen protector", maxPriceMinor: 500 });
    const events = await lastEvents();
    const ofB = events.find((event) => event.attributedShopId === ids.shopB);
    expect(ofB?.attributionProductIds).toEqual(
      expect.not.arrayContaining([DEMO_PRODUCT_ID, DEMO_SERVICE_ID]),
    );
    expect(ofB?.attributionProductIds).toContain(ids.premiumB);
  });
});

describe("what an event keeps", () => {
  it("drops contact details from the query and the search alike", async () => {
    await searchProducts(getDb(), {
      query: "screen repair anna.berzina@example.com +371 2000 0000 https://example.com/me",
      location: "Liepaja",
    });
    const [event] = await lastEvents();
    expect(event.queryNormalized).toBe("screen repair");
    expect(event.resultCount).toBeGreaterThan(0);
    expect(event.location).toBe("liepaja");
  });

  it("stores nothing when nothing of the query is left", async () => {
    await searchProducts(getDb(), { query: "anna@example.com" });
    await searchProducts(getDb(), { query: "%%%" });
    expect(await lastEvents()).toEqual([]);
  });

  it("survives control characters in a query", async () => {
    const { products } = await searchProducts(getDb(), { query: "cat\u0000 food\u0007" });
    expect(products.map((product) => product.productId)).toEqual([ids.foodC]);
    expect((await lastEvents())[0].queryNormalized).toBe("cat food");
  });

  it("stays within its bounds for the longest query", async () => {
    const words = Array.from({ length: 40 }, (_, i) => `w${"o".repeat(4)}rd${i}`).join(" ");
    await searchProducts(getDb(), { query: words.slice(0, 200) });
    const [event] = await lastEvents();
    expect(event.queryNormalized.length).toBeLessThanOrEqual(200);
    expect(event.queryNormalized.split(" ").length).toBeLessThanOrEqual(24);
  });

  it("answers the search even if the event cannot be written", async () => {
    const db = getDb();
    const insert = vi.spyOn(db, "insert").mockImplementationOnce(() => {
      throw new Error("anna@example.com is in this message");
    });
    const log = vi.mocked(console.error);
    log.mockClear();
    const { products } = await searchProducts(db, { query: "cat food" });
    expect(products.map((product) => product.productId)).toEqual([ids.foodC]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("anna");
    insert.mockRestore();
  });

  it("keeps a served event free of any shop", async () => {
    await idsFor({ query: "cat food" });
    const [event] = await getDb()
      .select()
      .from(searchEvents)
      .where(eq(searchEvents.queryNormalized, "cat food"));
    expect(event.attributedShopId).toBeNull();
    expect(event.matchedProductIds).toEqual([ids.foodC]);
  });
});
