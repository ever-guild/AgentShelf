import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import { createProduct, createShop, violatedConstraint } from "../../../test/fixtures";
import { createImportHarness, rowsOf } from "../../../test/imports";
import { CLIENT_SECRET, MERCHANT_ID, readOrder } from "../../../test/payments";
import { createFakePayPal, type FakePayPal } from "../../../test/paypal-fake";
import {
  importJobs,
  importRows,
  orderLines,
  paypalMerchantConnections,
  products,
  sellerOwners,
  shopMemberships,
  shops,
} from "../db/schema";
import { buildCatalogRecord, catalogRecordId } from "../paypal/catalog";
import { createPayPalProvider } from "../paypal/orders";
import { getPublishedProduct, listPublishedProducts, searchProducts } from "./catalog";
import { getStorefront, getStorefrontProduct } from "./storefront";
import { createCheckout } from "./checkout";
import { quoteCheckout } from "./checkout-quote";
import {
  applyBulkAction,
  createImport,
  finishImportReview,
  getImport,
  listImports,
  updateImportRow,
} from "./imports";
import {
  getSellerCatalog,
  publishImport,
  syncCatalog,
  updateCatalogProduct,
  type CatalogChange,
  type CatalogDeps,
} from "./seller-catalog";

const getDb = setupMigratedDatabase();

const CSV = `name,price,currency,kind,duration,deposit,description
Tempered glass,9.90,EUR,product,,,9H glass for iPhone 13
USB-C cable,7.50,EUR,product,,,
Screen repair,80.00,EUR,service,60,20.00,Same day
`;

let errorLog: ReturnType<typeof vi.spyOn>;
let paypal: FakePayPal;
let changes: CatalogChange[];
let deps: CatalogDeps;

const credentials = {
  PAYPAL_CLIENT_ID_TEST_SHOP: "test-client-id",
  PAYPAL_CLIENT_SECRET_TEST_SHOP: CLIENT_SECRET,
};

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "https://shop.example");
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  paypal = createFakePayPal();
  changes = [];
  deps = {
    paypalFor: createPayPalProvider(credentials, paypal.adapter),
    onCatalogChange: async (_tx, change) => {
      changes.push(change);
    },
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  errorLog.mockRestore();
});

const code = (expected: string) => expect.objectContaining({ code: expected });

const noCredentials = (): CatalogDeps => ({ ...deps, paypalFor: () => undefined });

// A CSV import taken as far as a finished review, which is where publication starts.
async function finishedImport(
  csv = CSV,
  shop?: Awaited<ReturnType<typeof createShop>>,
) {
  const owner = shop ?? (await createShop(getDb(), { paypalMerchantId: MERCHANT_ID }));
  const view = await createImport(
    getDb(),
    owner,
    { name: "prices.csv", bytes: Buffer.from(csv) },
    createImportHarness().deps,
  );
  await applyBulkAction(getDb(), owner, view.id, { action: "accept_clean" });
  await finishImportReview(getDb(), owner, view.id);
  return { shop: owner, jobId: view.id };
}

async function publishedShop(csv = CSV) {
  const { shop, jobId } = await finishedImport(csv);
  await publishImport(getDb(), shop, jobId, deps);
  return { shop, jobId, catalog: await getSellerCatalog(getDb(), shop) };
}

const productsOf = (shopId: string) =>
  getDb().select().from(products).where(eq(products.shopId, shopId));

async function productNamed(shopId: string, title: string) {
  const [row] = await getDb()
    .select()
    .from(products)
    .where(and(eq(products.shopId, shopId), eq(products.title, title)));
  return row;
}

async function syncAll(shop: { id: string; currency: string }) {
  let answer = await syncCatalog(getDb(), shop, {}, deps);
  while (answer.remaining > 0 && !answer.stopped) {
    answer = await syncCatalog(getDb(), shop, {}, deps);
  }
  return answer;
}

const search = async (query: string) =>
  (await searchProducts(getDb(), { query })).products.map((product) => product.title);

const checkoutFor = (productId: string, idempotencyKey = randomUUID()) =>
  createCheckout(
    getDb(),
    { items: [{ productId, quantity: 1 }], idempotencyKey },
    { paypalFor: deps.paypalFor },
  );

describe("publishing a finished import", () => {
  it("makes a reviewed product searchable only once it is published", async () => {
    const shop = await createShop(getDb());
    const view = await createImport(
      getDb(),
      shop,
      { name: "prices.csv", bytes: Buffer.from(CSV) },
      createImportHarness().deps,
    );
    await applyBulkAction(getDb(), shop, view.id, { action: "accept_clean" });
    expect(await search("tempered glass")).toEqual([]);

    await expect(publishImport(getDb(), shop, view.id, deps)).rejects.toEqual(
      code("IMPORT_REVIEW_INCOMPLETE"),
    );
    expect(await search("tempered glass")).toEqual([]);

    await finishImportReview(getDb(), shop, view.id);
    expect(await search("tempered glass")).toEqual([]);
    expect(await productsOf(shop.id)).toEqual([]);

    const published = await publishImport(getDb(), shop, view.id, deps);

    expect(await search("tempered glass")).toEqual(["Tempered glass"]);
    expect(published.publishedCount).toBe(3);
    expect(published.rows).toEqual([]);
    expect(await rowsOf(getDb(), view.id)).toEqual([]);
  });

  it("carries over what the seller reviewed, in both languages", async () => {
    const shop = await createShop(getDb());
    const view = await createImport(
      getDb(),
      shop,
      { name: "prices.csv", bytes: Buffer.from(CSV) },
      createImportHarness().deps,
    );
    const [glass] = await rowsOf(getDb(), view.id);
    await updateImportRow(getDb(), shop, view.id, glass.id, {
      descriptionEn: "Hard glass for the iPhone 13 screen.",
      descriptionLv: "Ciets aizsargstikls iPhone 13 ekrānam.",
    });
    await applyBulkAction(getDb(), shop, view.id, { action: "accept_clean" });
    await finishImportReview(getDb(), shop, view.id);
    await publishImport(getDb(), shop, view.id, deps);

    const product = await productNamed(shop.id, "Tempered glass");
    expect(product).toMatchObject({
      kind: "product",
      status: "published",
      priceMinor: 990,
      description: "Hard glass for the iPhone 13 screen.",
      descriptionEn: "Hard glass for the iPhone 13 screen.",
      descriptionLv: "Ciets aizsargstikls iPhone 13 ekrānam.",
      importJobId: view.id,
      importPosition: glass.position,
      paypalSyncStatus: "pending",
    });
    expect(await productNamed(shop.id, "Screen repair")).toMatchObject({
      kind: "service",
      priceMinor: 8000,
      depositMinor: 2000,
      serviceDurationMinutes: 60,
      description: "Same day",
      descriptionEn: null,
      descriptionLv: null,
    });
    // A buyer searching in Latvian finds it, and the storefront can read the text.
    const { products: found } = await searchProducts(getDb(), { query: "aizsargstikls" });
    expect(found.map((entry) => entry.descriptionLv)).toEqual([
      "Ciets aizsargstikls iPhone 13 ekrānam.",
    ]);
    const inLatvian = await getStorefront(getDb(), shop.slug, "lv", deps.paypalFor);
    expect(inLatvian.hasLatvian).toBe(true);
    expect(inLatvian.products.find((entry) => entry.id === product.id)).toMatchObject({
      description: "Ciets aizsargstikls iPhone 13 ekrānam.",
      descriptionLanguage: "lv",
    });
    const inEnglish = await getStorefront(getDb(), shop.slug, "en", deps.paypalFor);
    expect(inEnglish.products.find((entry) => entry.id === product.id)).toMatchObject({
      description: "Hard glass for the iPhone 13 screen.",
      descriptionLanguage: "en",
    });
  });

  it("publishes accepted rows only, and drops the removed ones", async () => {
    const shop = await createShop(getDb());
    const view = await createImport(
      getDb(),
      shop,
      { name: "prices.csv", bytes: Buffer.from(CSV) },
      createImportHarness().deps,
    );
    const [, cable] = await rowsOf(getDb(), view.id);
    await updateImportRow(getDb(), shop, view.id, cable.id, { status: "removed" });
    await applyBulkAction(getDb(), shop, view.id, { action: "accept_clean" });
    await finishImportReview(getDb(), shop, view.id);
    await publishImport(getDb(), shop, view.id, deps);

    expect((await productsOf(shop.id)).map((row) => row.title).sort()).toEqual([
      "Screen repair",
      "Tempered glass",
    ]);
    expect(await rowsOf(getDb(), view.id)).toEqual([]);
  });

  it("does not make a second product when repeated, one after another or at once", async () => {
    const { shop, jobId } = await finishedImport();

    await Promise.all([
      publishImport(getDb(), shop, jobId, deps),
      publishImport(getDb(), shop, jobId, deps),
      publishImport(getDb(), shop, jobId, deps),
    ]);
    await publishImport(getDb(), shop, jobId, deps);

    expect(await productsOf(shop.id)).toHaveLength(3);
    expect(changes).toHaveLength(1);
    expect((await getImport(getDb(), shop, jobId)).publishedCount).toBe(3);
  });

  it("does not make a second product from a draft that is somehow still there", async () => {
    const { shop, jobId } = await finishedImport("name,price,currency\nCable,7.50,EUR\n");
    const [draft] = await rowsOf(getDb(), jobId);
    await publishImport(getDb(), shop, jobId, deps);

    await getDb().insert(importRows).values(draft);
    await publishImport(getDb(), shop, jobId, deps);

    expect(await productsOf(shop.id)).toHaveLength(1);
    expect(await rowsOf(getDb(), jobId)).toEqual([]);
  });

  it("checks rows again, and keeps one that no longer passes as a draft", async () => {
    const { shop, jobId } = await finishedImport();
    await getDb()
      .update(importRows)
      .set({ currency: "USD" })
      .where(and(eq(importRows.jobId, jobId), eq(importRows.title, "USB-C cable")));

    const view = await publishImport(getDb(), shop, jobId, deps);

    expect((await productsOf(shop.id)).map((row) => row.title)).not.toContain("USB-C cable");
    expect(view.publishedCount).toBe(2);
    expect(view.rows.map((row) => row.title)).toEqual(["USB-C cable"]);
    expect(view.rows[0].issues.map((issue) => issue.code)).toContain("currency_mismatch");
    expect(view.counts).toMatchObject({ accepted: 1, blocked: 1 });
  });

  it("checks against the shop's current currency, not the one in a session", async () => {
    const { shop, jobId } = await finishedImport();
    await getDb().update(shops).set({ currency: "USD" }).where(eq(shops.id, shop.id));

    await publishImport(getDb(), shop, jobId, deps);

    expect(await productsOf(shop.id)).toEqual([]);
  });

  it("answers for another shop's import as if it did not exist, and changes nothing", async () => {
    const { jobId } = await finishedImport();
    const stranger = await createShop(getDb());

    await expect(publishImport(getDb(), stranger, jobId, deps)).rejects.toEqual(
      code("IMPORT_NOT_FOUND"),
    );
    await expect(publishImport(getDb(), stranger, "not-a-uuid", deps)).rejects.toEqual(
      code("IMPORT_NOT_FOUND"),
    );
    await expect(publishImport(getDb(), stranger, randomUUID(), deps)).rejects.toEqual(
      code("IMPORT_NOT_FOUND"),
    );
    expect(await productsOf(stranger.id)).toEqual([]);
    expect(await rowsOf(getDb(), jobId)).toHaveLength(3);
  });

  it("shows what was published in the list of uploads", async () => {
    const { shop } = await publishedShop();
    const [entry] = await listImports(getDb(), shop);
    expect(entry).toMatchObject({ publishedCount: 3, rowCount: 0 });
  });

  it("writes nothing if the search index cannot be told", async () => {
    const { shop, jobId } = await finishedImport();
    const failing: CatalogDeps = {
      ...deps,
      onCatalogChange: async () => {
        throw new Error("index unavailable");
      },
    };

    await expect(publishImport(getDb(), shop, jobId, failing)).rejects.toThrow("index unavailable");

    expect(await productsOf(shop.id)).toEqual([]);
    expect(await rowsOf(getDb(), jobId)).toHaveLength(3);
  });

  it("tells the search index about every change that affects buyers", async () => {
    const { shop } = await publishedShop();
    const glass = await productNamed(shop.id, "Tempered glass");
    expect(changes).toEqual([
      {
        shopId: shop.id,
        productIds: expect.arrayContaining([glass.id]),
        change: "published",
      },
    ]);

    changes.length = 0;
    await updateCatalogProduct(getDb(), shop, glass.id, { price: "11.00" }, deps);
    await updateCatalogProduct(getDb(), shop, glass.id, { price: "11.00" }, deps);
    await updateCatalogProduct(getDb(), shop, glass.id, { status: "unpublished" }, deps);
    await updateCatalogProduct(getDb(), shop, glass.id, { status: "unpublished" }, deps);
    await updateCatalogProduct(getDb(), shop, glass.id, { status: "published" }, deps);
    expect(changes.map((entry) => [entry.productIds, entry.change])).toEqual([
      [[glass.id], "edited"],
      [[glass.id], "unpublished"],
      [[glass.id], "published"],
    ]);
  });
});

describe("the PayPal Catalog record", () => {
  it("publishes Catalog records only through the shop's verified platform merchant context", async () => {
    const shop = await createShop(getDb(), {
      paypalCredentialRef: "PAYPAL_PLATFORM",
      paypalMerchantId: "STALE_LEGACY_SELLER",
    });
    const ownerId = randomUUID();
    const trackingId = "verified-tracking-id-1234567890-abcdefghijklmno";
    const sellerMerchantId = "CONNECTEDSELLER123";
    const now = new Date("2026-11-06T12:00:00Z");
    await getDb().insert(sellerOwners).values({
      id: ownerId,
      username: `owner-${randomUUID().slice(0, 8)}`,
      passwordHash: `scrypt$16384$8$1$${"A".repeat(22)}$${"B".repeat(43)}`,
    });
    await getDb().insert(shopMemberships).values({ ownerId, shopId: shop.id });
    await getDb().insert(paypalMerchantConnections).values({
      shopId: shop.id,
      consentedByOwnerId: ownerId,
      shareDataConsentAt: now,
      status: "ready",
      trackingId,
      requestKeyHash: "1".repeat(64),
      sellerMerchantId,
      statusEvidence: {
        merchantId: sellerMerchantId,
        trackingId,
        paymentsReceivable: true,
        primaryEmailConfirmed: true,
        consentGranted: true,
        activeProducts: ["EXPRESS_CHECKOUT"],
        grantedScopes: ["https://uri.paypal.com/services/payments/payment/authcapture"],
      },
      createdAt: now,
      updatedAt: now,
    });

    const platformPayPal = createFakePayPal();
    const platformDeps: CatalogDeps = {
      ...deps,
      paypalFor: createPayPalProvider({
        PAYPAL_PLATFORM_CLIENT_ID: "sandbox-platform-client-id",
        PAYPAL_PLATFORM_CLIENT_SECRET: "sandbox-platform-client-secret",
        PAYPAL_PARTNER_ATTRIBUTION_ID: "AGENT_SHELF_BN_CODE",
      }, platformPayPal.adapter),
    };
    const { jobId } = await finishedImport(CSV, shop);
    await publishImport(getDb(), shop, jobId, platformDeps);
    expect((await productNamed(shop.id, "Tempered glass")).paypalSyncStatus).toBe("pending");

    const answer = await syncCatalog(getDb(), shop, {}, platformDeps);
    expect(answer).toMatchObject({ remaining: 0, stopped: false });
    const requests = platformPayPal.catalogCreateRequests();
    expect(requests).toHaveLength(3);
    const expectedAssertion = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64")}.${Buffer.from(JSON.stringify({ iss: "sandbox-platform-client-id", payer_id: sellerMerchantId })).toString("base64")}.`;
    for (const request of requests) {
      expect(request.headers).toMatchObject({
        "PayPal-Auth-Assertion": expectedAssertion,
        "PayPal-Partner-Attribution-Id": "AGENT_SHELF_BN_CODE",
      });
    }
    expect(platformPayPal.tokenRequests()[0].headers).not.toHaveProperty("PayPal-Auth-Assertion");
    expect(platformPayPal.tokenRequests()[0].headers).not.toHaveProperty("PayPal-Partner-Attribution-Id");
  });

  it("sends only what a record holds, with a fixed key and ID per product", async () => {
    const { shop } = await publishedShop();
    const answer = await syncAll(shop);

    expect(answer).toMatchObject({ remaining: 0, stopped: false });
    const glass = await productNamed(shop.id, "Tempered glass");
    const cable = await productNamed(shop.id, "USB-C cable");
    const repair = await productNamed(shop.id, "Screen repair");
    const requests = paypal.catalogCreateRequests();
    const records = requests.map((request) => paypal.bodyOf(request));
    expect(records).toEqual(expect.arrayContaining([
      {
        id: catalogRecordId(glass.id),
        name: "Tempered glass",
        type: "PHYSICAL",
        description: "9H glass for iPhone 13",
      },
      {
        id: catalogRecordId(cable.id),
        name: "USB-C cable",
        type: "PHYSICAL",
      },
      {
        id: catalogRecordId(repair.id),
        name: "Screen repair",
        type: "SERVICE",
        description: "Same day",
      },
    ]));
    const toGlass = requests.find((request) => paypal.requestIdOf(request) === glass.id);
    expect(paypal.bodyOf(toGlass!)).toEqual({
      id: catalogRecordId(glass.id),
      name: "Tempered glass",
      type: "PHYSICAL",
      description: "9H glass for iPhone 13",
    });
    const toRepair = requests.find((request) => paypal.requestIdOf(request) === repair.id);
    expect(paypal.bodyOf(toRepair!)).toMatchObject({ type: "SERVICE" });
    const recordKeys = ["description", "id", "name", "type"];
    for (const body of records) {
      expect(Object.keys(body).sort()).toEqual(
        Object.keys(body).filter((key) => recordKeys.includes(key)).sort(),
      );
      expect(body).not.toHaveProperty("price");
      expect(body).not.toHaveProperty("priceMinor");
      expect(body).not.toHaveProperty("unit_amount");
      expect(body).not.toHaveProperty("deposit");
      expect(body).not.toHaveProperty("depositMinor");
      expect(body).not.toHaveProperty("stock");
    }

    expect(glass).toMatchObject({
      paypalSyncStatus: "synced",
      paypalProductId: catalogRecordId(glass.id),
      paypalSyncError: null,
    });
    expect(glass.paypalSyncedAt).toBeInstanceOf(Date);
    expect(paypal.catalogRecords()).toHaveLength(3);
  });

  it("does not send a blank description, or more than PayPal allows", () => {
    const record = buildCatalogRecord({
      id: "00000000-0000-4000-8000-000000000001",
      kind: "product",
      title: "ā".repeat(200),
      description: "  ",
    });
    expect(record).not.toHaveProperty("description");
    expect(record.name).toHaveLength(127);
    expect(record.id.length).toBeLessThanOrEqual(50);
    expect(
      buildCatalogRecord({ ...{ id: "x", kind: "service", title: "T" }, description: "d".repeat(300) })
        .description,
    ).toHaveLength(256);
  });

  it("keeps each product's own result when some fail, and recovers with a retry", async () => {
    const { shop } = await publishedShop();
    paypal.nextCatalogCreate({ type: "respond", status: 201, body: { id: "PROD-SOMETHING-ELSE" } });
    paypal.nextCatalogCreate({
      type: "respond",
      status: 400,
      body: { name: "INVALID_REQUEST", details: [{ issue: "INVALID_PARAMETER_VALUE" }] },
    });

    const answer = await syncAll(shop);

    expect(answer.remaining).toBe(0);
    const statuses = answer.view.products.map((product) => product.sync.status).sort();
    expect(statuses).toEqual(["failed", "failed", "synced"]);
    const failed = answer.view.products.filter((product) => product.sync.status === "failed");
    expect(failed.every((product) => product.sync.problem && !product.sync.paypalProductId)).toBe(true);
    // The rest of the catalog sells throughout.
    expect(answer.view.counts).toMatchObject({ published: 3, unsent: 2, waiting: 0 });

    const one = await syncCatalog(getDb(), shop, { productId: failed[0].id }, deps);
    expect(one.view.products.filter((p) => p.sync.status === "failed")).toHaveLength(1);
    expect(paypal.catalogRecords()).toHaveLength(2);

    const rest = await syncCatalog(getDb(), shop, { retryFailed: true }, deps);
    expect(rest.view.counts.unsent).toBe(0);
    expect(paypal.catalogRecords()).toHaveLength(3);
  });

  it("does not repeat a request for what has already been sent", async () => {
    const { shop } = await publishedShop();
    await syncAll(shop);
    const sent = paypal.catalogCreateRequests().length;
    const glass = await productNamed(shop.id, "Tempered glass");

    await syncCatalog(getDb(), shop, { retryFailed: true }, deps);
    await syncCatalog(getDb(), shop, { productId: glass.id }, deps);

    expect(paypal.catalogCreateRequests()).toHaveLength(sent);
  });

  it("makes no second record when the answer to the first was lost", async () => {
    const { shop } = await publishedShop("name,price,currency\nCable,7.50,EUR\n");
    paypal.nextCatalogCreate({ type: "timeout", recordCreated: true });

    const first = await syncCatalog(getDb(), shop, {}, deps);
    expect(first.stopped).toBe(true);
    expect(first.view.products[0].sync).toMatchObject({ status: "failed", paypalProductId: null });
    expect(paypal.catalogRecords()).toHaveLength(1);

    const second = await syncCatalog(getDb(), shop, { retryFailed: true }, deps);
    const third = await syncCatalog(getDb(), shop, { retryFailed: true }, deps);

    expect(second.view.products[0].sync.status).toBe("synced");
    expect(third.view.products[0].sync.status).toBe("synced");
    expect(paypal.catalogRecords()).toHaveLength(1);
    expect(paypal.catalogCreateRequests()).toHaveLength(2);
  });

  it("finds the record it made once PayPal has forgotten the key", async () => {
    const { shop } = await publishedShop("name,price,currency\nCable,7.50,EUR\n");
    paypal.nextCatalogCreate({ type: "timeout", recordCreated: true });
    await syncCatalog(getDb(), shop, {}, deps);
    paypal.forgetCatalogRequestIds();

    const answer = await syncCatalog(getDb(), shop, { retryFailed: true }, deps);

    const [product] = await productsOf(shop.id);
    expect(answer.view.products[0].sync.status).toBe("synced");
    expect(product.paypalProductId).toBe(catalogRecordId(product.id));
    expect(paypal.catalogRecords()).toHaveLength(1);
    expect(paypal.catalogReadRequests()).toHaveLength(1);
  });

  it("stays failed if the record it should have found cannot be read", async () => {
    const { shop } = await publishedShop("name,price,currency\nCable,7.50,EUR\n");
    const [product] = await productsOf(shop.id);
    paypal.nextCatalogCreate({
      type: "respond",
      status: 422,
      body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "DUPLICATE_RESOURCE_IDENTIFIER" }] },
    });
    paypal.nextCatalogRead({ type: "timeout" });
    const lost = await syncCatalog(getDb(), shop, {}, deps);
    expect(lost.view.products[0].sync.status).toBe("failed");

    paypal.nextCatalogCreate({
      type: "respond",
      status: 422,
      body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "DUPLICATE_RESOURCE_IDENTIFIER" }] },
    });
    paypal.nextCatalogRead({ type: "respond", status: 200, body: { id: "PROD-ANOTHER" } });
    const other = await syncCatalog(getDb(), shop, { retryFailed: true }, deps);
    expect(other.view.products[0].sync).toMatchObject({ status: "failed", paypalProductId: null });
    expect((await productsOf(shop.id))[0].id).toBe(product.id);
  });

  it("keeps a record a concurrent attempt stored, whatever this attempt heard", async () => {
    const { shop } = await publishedShop("name,price,currency\nCable,7.50,EUR\n");
    const [product] = await productsOf(shop.id);
    const real = deps.paypalFor("TEST_SHOP");
    const racing: CatalogDeps = {
      ...deps,
      paypalFor: () =>
        real && {
          ...real,
          createCatalogRecord: async () => {
            await getDb()
              .update(products)
              .set({
                paypalSyncStatus: "synced",
                paypalProductId: catalogRecordId(product.id),
                paypalSyncedAt: new Date(),
              })
              .where(eq(products.id, product.id));
            throw Object.assign(new Error("timeout"), { code: "ECONNABORTED" });
          },
        },
    };

    const answer = await syncCatalog(getDb(), shop, {}, racing);

    expect(answer.view.products[0].sync).toMatchObject({
      status: "synced",
      paypalProductId: catalogRecordId(product.id),
    });
  });

  it("stops a batch when PayPal is not answering, and leaves the rest waiting", async () => {
    const { shop } = await publishedShop();
    paypal.nextCatalogCreate({ type: "timeout", recordCreated: false });

    const answer = await syncCatalog(getDb(), shop, {}, deps);

    expect(answer).toMatchObject({ stopped: true, remaining: 2 });
    expect(paypal.catalogCreateRequests()).toHaveLength(1);
    expect(answer.view.counts).toMatchObject({ waiting: 2, unsent: 3, published: 3 });

    const next = await syncCatalog(getDb(), shop, {}, deps);
    expect(next).toMatchObject({ stopped: false, remaining: 0 });
    expect(paypal.catalogRecords()).toHaveLength(2);
  });

  it("carries on past a refusal, which is about that one record", async () => {
    const { shop } = await publishedShop();
    paypal.nextCatalogCreate({
      type: "respond",
      status: 422,
      body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "COUNTRY_NOT_SUPPORTED" }] },
    });

    const answer = await syncCatalog(getDb(), shop, {}, deps);

    expect(answer).toMatchObject({ stopped: false, remaining: 0 });
    expect(paypal.catalogRecords()).toHaveLength(2);
    expect(paypal.catalogReadRequests()).toEqual([]);
  });

  it("says when PayPal refuses the shop's credentials", async () => {
    const { shop } = await publishedShop();
    paypal.nextToken({ type: "respond", status: 401, body: { error: "invalid_client" } });

    const answer = await syncCatalog(getDb(), shop, {}, deps);

    expect(answer.stopped).toBe(true);
    const failed = answer.view.products.find((product) => product.sync.status === "failed");
    expect(failed?.sync.problem).toContain("credentials");
    expect((await syncCatalog(getDb(), shop, { retryFailed: true }, deps)).remaining).toBe(0);
  });

  it("logs short codes only", async () => {
    const { shop } = await publishedShop();
    paypal.nextCatalogCreate({
      type: "respond",
      status: 400,
      body: { name: "INVALID_REQUEST", debug_id: "abc123", message: "Tempered glass was refused" },
    });

    await syncCatalog(getDb(), shop, {}, deps);

    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).toContain("INVALID_REQUEST");
    expect(logged).not.toContain(CLIENT_SECRET);
    expect(logged).not.toContain("Tempered glass");
    expect(logged).not.toContain("Bearer");
  });

  it("publishes without credentials, and syncs once they exist", async () => {
    const { shop, jobId } = await finishedImport();

    await publishImport(getDb(), shop, jobId, noCredentials());

    const catalog = await getSellerCatalog(getDb(), shop);
    expect(catalog.counts).toMatchObject({ published: 3, waiting: 0, unsent: 3 });
    expect(catalog.products.every((p) => p.sync.status === "not_configured" && p.sync.problem)).toBe(true);
    expect(await search("tempered glass")).toEqual(["Tempered glass"]);
    expect(paypal.requests).toEqual([]);

    const still = await syncCatalog(getDb(), shop, { retryFailed: true }, noCredentials());
    expect(still).toMatchObject({ remaining: 0, stopped: false });
    expect(still.view.products.every((p) => p.sync.status === "not_configured")).toBe(true);
    expect(paypal.requests).toEqual([]);

    const answer = await syncCatalog(getDb(), shop, { retryFailed: true }, deps);
    expect(answer.view.counts.unsent).toBe(0);
    expect(paypal.catalogRecords()).toHaveLength(3);
  });

  it("does not send an unpublished product, and keeps the record of one taken off sale", async () => {
    const { shop } = await publishedShop();
    const glass = await productNamed(shop.id, "Tempered glass");
    const cable = await productNamed(shop.id, "USB-C cable");
    await syncCatalog(getDb(), shop, { productId: cable.id }, deps);
    await updateCatalogProduct(getDb(), shop, cable.id, { status: "unpublished" }, deps);
    await updateCatalogProduct(getDb(), shop, glass.id, { status: "unpublished" }, deps);
    const sent = paypal.catalogCreateRequests().length;

    await syncAll(shop);
    await syncCatalog(getDb(), shop, { productId: glass.id }, deps);

    const titles = paypal.catalogRecords().map((record) => record.name);
    expect(titles).not.toContain("Tempered glass");
    expect(titles).toContain("USB-C cable");
    expect(paypal.catalogCreateRequests().length).toBe(sent + 1);
    expect(await productNamed(shop.id, "USB-C cable")).toMatchObject({
      status: "unpublished",
      paypalSyncStatus: "synced",
      paypalProductId: catalogRecordId(cable.id),
    });
    expect(paypal.requests.some((request) => request.method.toLowerCase() === "delete")).toBe(false);
  });

  it("answers for another shop's product as if it did not exist", async () => {
    const { shop } = await publishedShop();
    const glass = await productNamed(shop.id, "Tempered glass");
    const stranger = await createShop(getDb());
    await createProduct(getDb(), stranger.id, { title: "Theirs" });

    await expect(
      syncCatalog(getDb(), stranger, { productId: glass.id }, deps),
    ).rejects.toEqual(code("PRODUCT_NOT_FOUND"));
    await expect(
      syncCatalog(getDb(), stranger, { productId: randomUUID() }, deps),
    ).rejects.toEqual(code("PRODUCT_NOT_FOUND"));
    expect(paypal.catalogCreateRequests()).toEqual([]);

    // A batch sends this shop's products, and nobody else's.
    await syncAll(stranger);
    expect(paypal.catalogRecords().map((record) => record.name)).toEqual(["Theirs"]);
    expect((await getSellerCatalog(getDb(), stranger)).products.map((p) => p.title)).toEqual(["Theirs"]);
  });

  it("refuses a sync request that names anything else", async () => {
    const { shop } = await publishedShop();
    await expect(
      syncCatalog(getDb(), shop, { shopId: shop.id }, deps),
    ).rejects.toEqual(code("INVALID_INPUT"));
    await expect(
      syncCatalog(getDb(), shop, { productId: "nope" }, deps),
    ).rejects.toEqual(code("INVALID_INPUT"));
  });
});

describe("what is discoverable", () => {
  it("follows publication alone, in search, the catalog and checkout, whatever PayPal Catalog says", async () => {
    const { shop } = await publishedShop();
    const glass = await productNamed(shop.id, "Tempered glass");
    paypal.nextCatalogCreate({ type: "respond", status: 400, body: { name: "INVALID_REQUEST" } });
    await syncCatalog(getDb(), shop, { productId: glass.id }, deps);
    expect((await productNamed(shop.id, "Tempered glass")).paypalSyncStatus).toBe("failed");

    const items = [{ productId: glass.id, quantity: 1 }];
    expect(await search("tempered glass")).toEqual(["Tempered glass"]);
    expect((await listPublishedProducts(getDb(), { shopId: shop.id })).map((p) => p.title)).toContain(
      "Tempered glass",
    );
    await expect(
      getPublishedProduct(getDb(), { shopId: shop.id, productId: glass.id }),
    ).resolves.toMatchObject({ title: "Tempered glass" });
    await expect(
      quoteCheckout(getDb(), { items, idempotencyKey: randomUUID() }),
    ).resolves.toMatchObject({ totalMinor: 990 });

    const onStorefront = async () =>
      (await getStorefront(getDb(), shop.slug, "en", deps.paypalFor)).products.map((p) => p.title);
    expect(await onStorefront()).toContain("Tempered glass");

    await updateCatalogProduct(getDb(), shop, glass.id, { status: "unpublished" }, deps);

    expect(await onStorefront()).not.toContain("Tempered glass");
    await expect(
      getStorefrontProduct(getDb(), shop.slug, glass.id, "en", deps.paypalFor),
    ).rejects.toEqual(code("PRODUCT_NOT_FOUND"));
    expect(await search("tempered glass")).toEqual([]);
    expect((await listPublishedProducts(getDb(), { shopId: shop.id })).map((p) => p.title)).not.toContain(
      "Tempered glass",
    );
    await expect(
      getPublishedProduct(getDb(), { shopId: shop.id, productId: glass.id }),
    ).rejects.toEqual(code("PRODUCT_NOT_FOUND"));
    await expect(
      quoteCheckout(getDb(), { items, idempotencyKey: randomUUID() }),
    ).rejects.toEqual(code("PRODUCT_NOT_FOUND"));

    await updateCatalogProduct(getDb(), shop, glass.id, { status: "published" }, deps);
    expect(await search("tempered glass")).toEqual(["Tempered glass"]);
  });

  it("does not show a Catalog identifier or sync state to a buyer", async () => {
    const { shop } = await publishedShop();
    await syncAll(shop);
    const { products: found } = await searchProducts(getDb(), { query: "tempered glass" });
    expect(JSON.stringify(found)).not.toMatch(/AS-|paypal|sync/i);
  });
});

describe("editing a published product", () => {
  it("changes future checkouts and leaves existing orders as they were", async () => {
    const { shop } = await publishedShop();
    const glass = await productNamed(shop.id, "Tempered glass");
    const key = randomUUID();
    const before = await checkoutFor(glass.id, key);
    expect(before.totalMinor).toBe(990);

    const view = await updateCatalogProduct(getDb(), shop, glass.id, { price: "12,50" }, deps);
    expect(view.products.find((product) => product.id === glass.id)?.price).toBe("12.50");

    const after = await checkoutFor(glass.id);
    expect(after.totalMinor).toBe(1250);

    const old = await readOrder(getDb(), before.orderId);
    expect(old.totalMinor).toBe(990);
    const [line] = await getDb()
      .select()
      .from(orderLines)
      .where(eq(orderLines.orderId, before.orderId));
    expect(line).toMatchObject({ unitPriceMinor: 990, lineTotalMinor: 990, title: "Tempered glass" });
    // A retry of the first order gets the first order.
    await expect(checkoutFor(glass.id, key)).resolves.toMatchObject({
      orderId: before.orderId,
      totalMinor: 990,
    });
    expect(paypal.bodyOf(paypal.createRequests().at(-1)!).purchase_units[0].amount.value).toBe("12.50");
  });

  it("keeps an existing order as it was when the product is unpublished", async () => {
    const { shop } = await publishedShop();
    const glass = await productNamed(shop.id, "Tempered glass");
    const key = randomUUID();
    const order = await checkoutFor(glass.id, key);

    await updateCatalogProduct(getDb(), shop, glass.id, { status: "unpublished" }, deps);

    await expect(checkoutFor(glass.id)).rejects.toEqual(code("PRODUCT_NOT_FOUND"));
    await expect(checkoutFor(glass.id, key)).resolves.toMatchObject({
      orderId: order.orderId,
      totalMinor: 990,
    });
    expect((await readOrder(getDb(), order.orderId)).totalMinor).toBe(990);
  });

  it("sends nothing to PayPal for a price, and keeps a synced record synced", async () => {
    const { shop } = await publishedShop();
    await syncAll(shop);
    const glass = await productNamed(shop.id, "Tempered glass");
    const sent = paypal.requests.length;

    await updateCatalogProduct(getDb(), shop, glass.id, { price: "12.00" }, deps);

    expect(paypal.requests).toHaveLength(sent);
    expect(await productNamed(shop.id, "Tempered glass")).toMatchObject({
      priceMinor: 1200,
      paypalSyncStatus: "synced",
    });
  });

  it.each([
    ["", "Enter a price."],
    ["free", "Enter one amount"],
    ["1.200", "two ways"],
    ["0", "more than zero"],
    ["12 USD", "sells in EUR"],
  ])("refuses a price of %j and keeps the old one", async (price, message) => {
    const { shop } = await publishedShop();
    const glass = await productNamed(shop.id, "Tempered glass");

    await expect(
      updateCatalogProduct(getDb(), shop, glass.id, { price }, deps),
    ).rejects.toMatchObject({
      code: "CATALOG_EDIT_INVALID",
      message: expect.stringContaining(message),
      details: { field: "price" },
    });

    expect((await productNamed(shop.id, "Tempered glass")).priceMinor).toBe(990);
  });

  it("keeps a service's deposit within its price", async () => {
    const { shop } = await publishedShop();
    const repair = await productNamed(shop.id, "Screen repair");

    await expect(
      updateCatalogProduct(getDb(), shop, repair.id, { price: "10.00" }, deps),
    ).rejects.toMatchObject({ code: "CATALOG_EDIT_INVALID", details: { field: "price" } });
    await expect(
      updateCatalogProduct(getDb(), shop, repair.id, { deposit: "90.00" }, deps),
    ).rejects.toMatchObject({ code: "CATALOG_EDIT_INVALID", details: { field: "deposit" } });

    await updateCatalogProduct(getDb(), shop, repair.id, { price: "10.00", deposit: "5.00" }, deps);
    expect(await productNamed(shop.id, "Screen repair")).toMatchObject({
      priceMinor: 1000,
      depositMinor: 500,
    });
  });

  it("gives a deposit only to a service", async () => {
    const { shop } = await publishedShop();
    const glass = await productNamed(shop.id, "Tempered glass");
    await expect(
      updateCatalogProduct(getDb(), shop, glass.id, { deposit: "1.00" }, deps),
    ).rejects.toEqual(code("CATALOG_EDIT_INVALID"));
  });

  it("answers for another shop's product as if it did not exist, and changes nothing", async () => {
    const { shop } = await publishedShop();
    const glass = await productNamed(shop.id, "Tempered glass");
    const stranger = await createShop(getDb());

    for (const patch of [{ price: "1.00" }, { status: "unpublished" }]) {
      await expect(
        updateCatalogProduct(getDb(), stranger, glass.id, patch, deps),
      ).rejects.toEqual(code("PRODUCT_NOT_FOUND"));
    }
    await expect(
      updateCatalogProduct(getDb(), stranger, "not-a-uuid", { price: "1.00" }, deps),
    ).rejects.toEqual(code("PRODUCT_NOT_FOUND"));

    expect(await productNamed(shop.id, "Tempered glass")).toMatchObject({
      priceMinor: 990,
      status: "published",
    });
    expect(changes).toHaveLength(1);
  });

  it("refuses a change that names anything else, or nothing", async () => {
    const { shop } = await publishedShop();
    const glass = await productNamed(shop.id, "Tempered glass");
    for (const patch of [
      {},
      { priceMinor: 1 },
      { shopId: shop.id },
      { paypalProductId: "PROD-1" },
      { status: "draft" },
    ]) {
      await expect(
        updateCatalogProduct(getDb(), shop, glass.id, patch, deps),
      ).rejects.toEqual(code("INVALID_INPUT"));
    }
  });

  it("leaves a draft product out of the seller's catalog", async () => {
    const shop = await createShop(getDb());
    const draft = await createProduct(getDb(), shop.id, { status: "draft", priceMinor: null });

    expect((await getSellerCatalog(getDb(), shop)).products).toEqual([]);
    await expect(
      updateCatalogProduct(getDb(), shop, draft.id, { status: "published" }, deps),
    ).rejects.toEqual(code("PRODUCT_NOT_FOUND"));
    await expect(syncCatalog(getDb(), shop, { productId: draft.id }, deps)).rejects.toEqual(
      code("PRODUCT_NOT_FOUND"),
    );
  });
});

describe("what the database holds to", () => {
  it("allows one product per draft", async () => {
    const { shop, jobId } = await publishedShop();
    const [{ importPosition }] = await productsOf(shop.id);
    expect(
      await violatedConstraint(
        createProduct(getDb(), shop.id, { importJobId: jobId, importPosition }),
      ),
    ).toBe("products_import_job_id_position_unique");
  });

  it("cannot call a product synced without its record", async () => {
    const shop = await createShop(getDb());
    expect(
      await violatedConstraint(createProduct(getDb(), shop.id, { paypalSyncStatus: "synced" })),
    ).toBe("products_synced_requires_record");
    expect(
      await violatedConstraint(
        createProduct(getDb(), shop.id, { paypalSyncStatus: "synced", paypalProductId: "AS-1" }),
      ),
    ).toBe("products_synced_requires_record");
  });

  it("cannot tie a product to another shop's import, or half of one", async () => {
    const { jobId } = await finishedImport();
    const stranger = await createShop(getDb());
    expect(
      await violatedConstraint(
        createProduct(getDb(), stranger.id, { importJobId: jobId, importPosition: 99 }),
      ),
    ).toBe("products_import_job_shop_fk");
    expect(
      await violatedConstraint(createProduct(getDb(), stranger.id, { importPosition: 1 })),
    ).toBe("products_import_source_complete");
  });

  it("gives a row from before this existed a state it can leave", async () => {
    const shop = await createShop(getDb());
    const [row] = await getDb().execute<{ paypal_sync_status: string }>(sql`
      INSERT INTO products (shop_id, kind, status, title, price_minor)
      VALUES (${shop.id}, 'product', 'published', 'Old row', 100)
      RETURNING paypal_sync_status
    `).then((result) => result.rows);
    expect(row.paypal_sync_status).toBe("pending");

    const answer = await syncAll(shop);
    expect(answer.view.products[0].sync.status).toBe("synced");
    await expect(
      getDb().select().from(importJobs).where(eq(importJobs.shopId, shop.id)),
    ).resolves.toEqual([]);
  });
});
