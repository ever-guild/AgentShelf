import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { applyBulkAction, createImport, finishImportReview } from "@/server/services/imports";
import { publishImport } from "@/server/services/seller-catalog";
import { createCheckout } from "@/server/services/checkout";
import { ownerSessionCookie, selectedOwnerShopCookie } from "@/server/seller-identity/http-auth";
import { PostgresAttemptLimiter, PostgresIdentityStore } from "@/server/seller-identity/postgres-store";
import { registerOwnerAndShop } from "@/server/seller-identity/service";
import { createTemporaryDatabase } from "../../../../../test/database";
import { createImportHarness } from "../../../../../test/imports";
import { MERCHANT_ID, createPaymentHarness } from "../../../../../test/payments";
import { GET as readStock, PATCH as adjustStock } from "./[productId]/route";
import { PUT as setStockMode } from "./[productId]/policy/route";

// Independent #36 F1 acceptance at the API/service boundary the seller UI must use: an imported and
// published physical product starts without a stock decision and cannot be bought; an explicit
// owner decision through the inventory routes makes exactly that stock purchasable.
const origin = "https://inventory-f1.test";
const signingSecret = "inventory-f1-acceptance-uses-a-private-secret-at-least-32-bytes";
const CSV = `name,price,currency,kind,duration,deposit,description
TEST tracked item,1.00,EUR,product,,,Synthetic
TEST untracked item,2.00,EUR,product,,,Synthetic
TEST zero item,3.00,EUR,product,,,Synthetic
TEST repair,30.00,EUR,service,30,5.00,Synthetic service
`;

function request(path: string, method: string, cookie: string, body?: unknown): Request {
  return new Request(`${origin}${path}`, {
    method,
    headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const params = (productId: string) => ({ params: Promise.resolve({ productId }) });

describe("#36 F1 acceptance: published product -> stock decision -> checkout eligibility", () => {
  let temporary: Awaited<ReturnType<typeof createTemporaryDatabase>>;
  let pool: Pool;
  let db: ReturnType<typeof createDb>["db"];
  let close: (() => Promise<void>) | undefined;
  let store: PostgresIdentityStore;
  let limiter: PostgresAttemptLimiter;
  const runtimeGlobal = globalThis as typeof globalThis & {
    agentshelfDb?: ReturnType<typeof createDb>["db"];
    agentshelfOwnerIdentityRuntime?: unknown;
  };

  beforeAll(async () => {
    process.env.APP_SIGNING_SECRET = signingSecret;
    temporary = await createTemporaryDatabase();
    await runMigrations(temporary.url);
    const database = createDb(temporary.url);
    db = database.db;
    runtimeGlobal.agentshelfDb = database.db;
    close = database.close;
    pool = (database.db as typeof db & { $client: Pool }).$client;
    store = new PostgresIdentityStore(pool);
    limiter = new PostgresAttemptLimiter(pool, signingSecret);
    runtimeGlobal.agentshelfOwnerIdentityRuntime = { store, limiter };
  });

  beforeEach(() => {
    vi.stubEnv("APP_ORIGIN", "https://shop.example");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(async () => {
    runtimeGlobal.agentshelfOwnerIdentityRuntime = undefined;
    delete runtimeGlobal.agentshelfDb;
    await close?.();
    await temporary?.drop();
    delete process.env.APP_SIGNING_SECRET;
  });

  it("requires an explicit owner stock decision before a published import can be checked out", async () => {
    const owner = await registerOwnerAndShop(store, limiter, {
      username: "f1-acceptance-owner",
      password: "correct horse battery staple",
      idempotencyKey: randomUUID(),
      shop: { name: "F1 test shop", slug: "f1-test-shop", location: "Riga, Latvia", currency: "EUR", timezone: "Europe/Riga" },
    }, "f1-acceptance");
    const shopId = owner.shop.id;
    const cookie = [
      ownerSessionCookie(owner.sessionToken, owner.expiresAt).split(";", 1)[0],
      selectedOwnerShopCookie(shopId, owner.expiresAt).split(";", 1)[0],
    ].join("; ");
    // Payment routing for the fake provider only; no PayPal account or consent is involved.
    await pool.query("UPDATE shops SET paypal_credential_ref='TEST_SHOP', paypal_merchant_id=$2 WHERE id=$1", [shopId, MERCHANT_ID]);
    const shop = { id: shopId, currency: "EUR" };

    const view = await createImport(db, shop, { name: "f1.csv", bytes: Buffer.from(CSV) }, createImportHarness().deps);
    await applyBulkAction(db, shop, view.id, { action: "accept_clean" });
    await finishImportReview(db, shop, view.id);
    await publishImport(db, shop, view.id, { paypalFor: () => undefined, onCatalogChange: async () => {} });
    const published = await pool.query<{ id: string; title: string; kind: string; status: string }>(
      "SELECT id, title, kind, status FROM products WHERE shop_id=$1 ORDER BY price_minor", [shopId],
    );
    const id = (title: string) => published.rows.find((row) => row.title === title)!.id;
    expect(published.rows.map((row) => row.status)).toEqual(["published", "published", "published", "published"]);

    // 1. Published but undecided: no implicit stock, the read says so, checkout refuses.
    expect((await pool.query("SELECT 1 FROM inventory_stock WHERE shop_id=$1", [shopId])).rowCount).toBe(0);
    const undecided = await readStock(request(`/api/seller/inventory/${id("TEST tracked item")}`, "GET", cookie), params(id("TEST tracked item")));
    expect(undecided.status).toBe(404);
    const harness = createPaymentHarness();
    const buy = (productId: string) => createCheckout(db, { items: [{ productId, quantity: 1 }], idempotencyKey: randomUUID() }, harness.deps);
    await expect(buy(id("TEST tracked item"))).rejects.toMatchObject({ code: "PRODUCT_UNAVAILABLE" });

    // 2. Explicit tracked 1 -> 1/0/1 -> exactly one unit can be reserved.
    const tracked = await setStockMode(
      request(`/api/seller/inventory/${id("TEST tracked item")}/policy`, "PUT", cookie, { mode: "tracked", onHand: 1, idempotencyKey: "f1-acceptance-tracked-0001", reason: "Owner counted one" }),
      params(id("TEST tracked item")),
    );
    expect(tracked.status).toBe(200);
    expect(await tracked.json()).toMatchObject({ mode: "tracked", onHand: 1, reserved: 0, available: 1, version: 0 });
    const first = await buy(id("TEST tracked item"));
    expect(first.orderId).toBeTruthy();
    await expect(buy(id("TEST tracked item"))).rejects.toMatchObject({ code: "PRODUCT_UNAVAILABLE" });
    const afterReserve = await readStock(request(`/api/seller/inventory/${id("TEST tracked item")}`, "GET", cookie), params(id("TEST tracked item")));
    expect(await afterReserve.json()).toMatchObject({ onHand: 1, reserved: 1, available: 0, version: 1 });

    // 3. A stale adjustment is refused and changes nothing; the client must re-read.
    const stale = await adjustStock(
      request(`/api/seller/inventory/${id("TEST tracked item")}`, "PATCH", cookie, { delta: 1, expectedVersion: 0, idempotencyKey: "f1-acceptance-stale-0001", reason: "Old form" }),
      params(id("TEST tracked item")),
    );
    expect(stale.status).toBe(409);
    const afterStale = await readStock(request(`/api/seller/inventory/${id("TEST tracked item")}`, "GET", cookie), params(id("TEST tracked item")));
    expect(await afterStale.json()).toMatchObject({ onHand: 1, reserved: 1, available: 0, version: 1 });

    // 4. Explicit untracked is purchasable; tracked 0 is not; a service gets no physical stock.
    const untracked = await setStockMode(
      request(`/api/seller/inventory/${id("TEST untracked item")}/policy`, "PUT", cookie, { mode: "untracked", idempotencyKey: "f1-acceptance-untracked-0001", reason: "Made to order" }),
      params(id("TEST untracked item")),
    );
    expect(untracked.status).toBe(200);
    await expect(buy(id("TEST untracked item"))).resolves.toMatchObject({ orderId: expect.any(String) });
    const zero = await setStockMode(
      request(`/api/seller/inventory/${id("TEST zero item")}/policy`, "PUT", cookie, { mode: "tracked", onHand: 0, idempotencyKey: "f1-acceptance-zero-0001", reason: "Sold out" }),
      params(id("TEST zero item")),
    );
    expect(zero.status).toBe(200);
    await expect(buy(id("TEST zero item"))).rejects.toMatchObject({ code: "PRODUCT_UNAVAILABLE" });
    const service = await setStockMode(
      request(`/api/seller/inventory/${id("TEST repair")}/policy`, "PUT", cookie, { mode: "tracked", onHand: 1, idempotencyKey: "f1-acceptance-service-0001", reason: "Not stock" }),
      params(id("TEST repair")),
    );
    expect(service.status).toBe(404);

    // 5. A policy cannot be silently replaced by a retry under a new key.
    const replace = await setStockMode(
      request(`/api/seller/inventory/${id("TEST tracked item")}/policy`, "PUT", cookie, { mode: "untracked", idempotencyKey: "f1-acceptance-replace-0001", reason: "Switch" }),
      params(id("TEST tracked item")),
    );
    expect(replace.status).toBe(409);
    const stock = await pool.query<{ product_id: string; mode: string; on_hand: number | null; reserved: number }>(
      "SELECT product_id, mode, on_hand, reserved FROM inventory_stock WHERE shop_id=$1", [shopId],
    );
    expect(stock.rows.find((row) => row.product_id === id("TEST tracked item"))).toMatchObject({ mode: "tracked", on_hand: 1, reserved: 1 });
    expect(stock.rows).toHaveLength(3);
  });
});
