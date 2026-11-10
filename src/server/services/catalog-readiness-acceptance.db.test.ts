import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import { createShop } from "../../../test/fixtures";
import { createImportHarness } from "../../../test/imports";
import { createFakePayPal, type FakePayPal } from "../../../test/paypal-fake";
import { paypalMerchantConnections, products, sellerOwners, shopMemberships } from "../db/schema";
import { createPayPalProvider } from "../paypal/orders";
import { applyBulkAction, createImport, finishImportReview } from "./imports";
import {
  getSellerCatalog,
  publishImport,
  syncCatalog,
  type CatalogDeps,
} from "./seller-catalog";

// Pins when a published product of a PayPal platform shop is `not_configured`, `pending`,
// `synced` or `failed`, against the fake PayPal. It says nothing about the real sandbox.

const getDb = setupMigratedDatabase();

const CSV = `name,price,currency,kind,duration,deposit,description
Tempered glass,9.90,EUR,product,,,9H glass
USB-C cable,7.50,EUR,product,,,
`;

const PLATFORM_ENV = {
  PAYPAL_PLATFORM_CLIENT_ID: "sandbox-platform-client-id",
  PAYPAL_PLATFORM_CLIENT_SECRET: "sandbox-platform-client-secret",
  PAYPAL_PARTNER_ATTRIBUTION_ID: "AGENT_SHELF_BN_CODE",
};

let errorLog: ReturnType<typeof vi.spyOn>;
let paypal: FakePayPal;

const depsWith = (env: Record<string, string>, fake = paypal): CatalogDeps => ({
  paypalFor: createPayPalProvider(env, fake.adapter),
  onCatalogChange: async () => {},
});

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", "https://shop.example");
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  paypal = createFakePayPal();
});

afterEach(() => {
  vi.unstubAllEnvs();
  errorLog.mockRestore();
});

const platformShop = () =>
  createShop(getDb(), { paypalCredentialRef: "PAYPAL_PLATFORM", paypalMerchantId: null });

async function connect(shopId: string, sellerMerchantId: string) {
  const ownerId = randomUUID();
  const trackingId = `verified-${randomUUID().replaceAll("-", "")}-abcdefghijklmn`;
  const now = new Date("2026-11-07T12:00:00Z");
  await getDb().insert(sellerOwners).values({
    id: ownerId,
    username: `owner-${randomUUID().slice(0, 8)}`,
    passwordHash: `scrypt$16384$8$1$${"A".repeat(22)}$${"B".repeat(43)}`,
  });
  await getDb().insert(shopMemberships).values({ ownerId, shopId });
  await getDb().insert(paypalMerchantConnections).values({
    shopId,
    consentedByOwnerId: ownerId,
    shareDataConsentAt: now,
    status: "ready",
    trackingId,
    requestKeyHash: randomUUID().replaceAll("-", "").repeat(2),
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
}

async function publish(shop: Awaited<ReturnType<typeof createShop>>, deps: CatalogDeps) {
  const view = await createImport(
    getDb(),
    shop,
    { name: "prices.csv", bytes: Buffer.from(CSV) },
    createImportHarness().deps,
  );
  await applyBulkAction(getDb(), shop, view.id, { action: "accept_clean" });
  await finishImportReview(getDb(), shop, view.id);
  await publishImport(getDb(), shop, view.id, deps);
}

async function statuses(shopId: string) {
  const rows = await getDb().select().from(products).where(eq(products.shopId, shopId));
  return rows.map((row) => `${row.paypalSyncStatus}${row.paypalSyncError ? `:${row.paypalSyncError}` : ""}`).sort();
}

// The merchant that the seller's authorization assertion names, read from the request header.
function payersOf(fake: FakePayPal) {
  return fake.catalogCreateRequests().map((request) => {
    const header = Object.entries(request.headers).find(
      ([name]) => name.toLowerCase() === "paypal-auth-assertion",
    )?.[1];
    const payload = String(header).split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64").toString()) as { iss: string; payer_id: string };
  });
}

describe("catalog readiness of a PayPal platform shop", () => {
  it("is not_configured for a shop with no merchant connection, and sends nothing", async () => {
    const shop = await platformShop();
    const deps = depsWith(PLATFORM_ENV);

    await publish(shop, deps);
    expect(await statuses(shop.id)).toEqual(["not_configured", "not_configured"]);

    await syncCatalog(getDb(), shop, { retryFailed: true }, deps);
    expect(await statuses(shop.id)).toEqual(["not_configured", "not_configured"]);
    expect(paypal.requests).toEqual([]);
  });

  it("goes pending, then synced, as the seller named by this shop's connection", async () => {
    const shop = await platformShop();
    await connect(shop.id, "CONNECTEDSELLERAAA");
    const deps = depsWith(PLATFORM_ENV);

    await publish(shop, deps);
    expect(await statuses(shop.id)).toEqual(["pending", "pending"]);
    expect((await getSellerCatalog(getDb(), shop)).counts.waiting).toBe(2);

    const answer = await syncCatalog(getDb(), shop, {}, deps);

    expect(answer).toMatchObject({ remaining: 0, stopped: false });
    expect(await statuses(shop.id)).toEqual(["synced", "synced"]);
    expect(paypal.catalogRecords()).toHaveLength(2);
    expect(payersOf(paypal)).toEqual([
      { iss: "sandbox-platform-client-id", payer_id: "CONNECTEDSELLERAAA" },
      { iss: "sandbox-platform-client-id", payer_id: "CONNECTEDSELLERAAA" },
    ]);
  });

  it.each([
    ["client id", "PAYPAL_PLATFORM_CLIENT_ID"],
    ["client secret", "PAYPAL_PLATFORM_CLIENT_SECRET"],
    ["partner attribution id", "PAYPAL_PARTNER_ATTRIBUTION_ID"],
  ])("is not_configured when the server lacks the platform %s", async (_name, missing) => {
    const shop = await platformShop();
    await connect(shop.id, "CONNECTEDSELLERBBB");
    const env: Record<string, string> = { ...PLATFORM_ENV };
    delete env[missing];
    const deps = depsWith(env);

    await publish(shop, deps);
    expect(await statuses(shop.id)).toEqual(["not_configured", "not_configured"]);
    await syncCatalog(getDb(), shop, { retryFailed: true }, deps);

    expect(await statuses(shop.id)).toEqual(["not_configured", "not_configured"]);
    expect(paypal.requests).toEqual([]);
  });

  it("is failed, not not_configured, when PayPal answers 403, and the batch stops", async () => {
    const shop = await platformShop();
    await connect(shop.id, "CONNECTEDSELLERCCC");
    const deps = depsWith(PLATFORM_ENV);
    await publish(shop, deps);
    paypal.nextCatalogCreate({ type: "respond", status: 403, body: { name: "NOT_AUTHORIZED" } });

    const answer = await syncCatalog(getDb(), shop, {}, deps);

    expect(answer).toMatchObject({ stopped: true, remaining: 1 });
    expect(await statuses(shop.id)).toEqual(["failed:not_authorized", "pending"]);
    expect(paypal.catalogCreateRequests()).toHaveLength(1);
  });

  it("is failed with timeout on ETIMEDOUT, and the batch stops", async () => {
    const shop = await platformShop();
    await connect(shop.id, "CONNECTEDSELLERDDD");
    const real = depsWith(PLATFORM_ENV);
    await publish(shop, real);
    let calls = 0;
    const deps: CatalogDeps = {
      ...real,
      paypalFor: (ref, payee) => {
        const sender = real.paypalFor(ref, payee);
        return (
          sender && {
            ...sender,
            createCatalogRecord: async () => {
              calls += 1;
              throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
            },
          }
        );
      },
    };

    const answer = await syncCatalog(getDb(), shop, {}, deps);

    expect(calls).toBe(1);
    expect(answer).toMatchObject({ stopped: true, remaining: 1 });
    expect(await statuses(shop.id)).toEqual(["failed:timeout", "pending"]);
  });

  it("never sends another shop's products, or uses another merchant, when syncing", async () => {
    const shopA = await platformShop();
    const shopB = await platformShop();
    await connect(shopA.id, "SELLERAAAAAAAA");
    await connect(shopB.id, "SELLERBBBBBBBB");
    const deps = depsWith(PLATFORM_ENV);
    await publish(shopA, deps);
    await publish(shopB, deps);

    await syncCatalog(getDb(), shopA, {}, deps);

    expect(await statuses(shopA.id)).toEqual(["synced", "synced"]);
    expect(await statuses(shopB.id)).toEqual(["pending", "pending"]);
    expect(payersOf(paypal).map((payer) => payer.payer_id)).toEqual(["SELLERAAAAAAAA", "SELLERAAAAAAAA"]);
  });

  describe("published before the connection was ready", () => {
    async function publishedEarly() {
      const shop = await platformShop();
      const deps = depsWith(PLATFORM_ENV);
      await publish(shop, deps);
      expect(await statuses(shop.id)).toEqual(["not_configured", "not_configured"]);
      await connect(shop.id, "CONNECTEDSELLEREEE");
      return { shop, deps };
    }

    it("is left alone by a plain sync, which is what the page does on load", async () => {
      const { shop, deps } = await publishedEarly();

      const answer = await syncCatalog(getDb(), shop, {}, deps);

      expect(answer).toMatchObject({ remaining: 0, stopped: false });
      expect(await statuses(shop.id)).toEqual(["not_configured", "not_configured"]);
      expect(paypal.requests).toEqual([]);
    });

    it("is sent by a retry of all failed, as that merchant", async () => {
      const { shop, deps } = await publishedEarly();

      await syncCatalog(getDb(), shop, { retryFailed: true }, deps);

      expect(await statuses(shop.id)).toEqual(["synced", "synced"]);
      expect(payersOf(paypal).map((payer) => payer.payer_id)).toEqual([
        "CONNECTEDSELLEREEE",
        "CONNECTEDSELLEREEE",
      ]);
    });

    it("is sent one at a time by a retry of that product", async () => {
      const { shop, deps } = await publishedEarly();
      const [first] = await getDb().select().from(products).where(eq(products.shopId, shop.id));

      await syncCatalog(getDb(), shop, { productId: first.id }, deps);

      expect(await statuses(shop.id)).toEqual(["not_configured", "synced"]);
      expect(paypal.catalogCreateRequests()).toHaveLength(1);
    });
  });
});
