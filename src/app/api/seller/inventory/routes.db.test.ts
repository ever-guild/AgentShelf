import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { createDb } from "@/server/db/client";
import { getDb } from "@/server/db";
import { runMigrations } from "@/server/db/migrate";
import { createTemporaryDatabase } from "../../../../../test/database";
import { OWNER_SELECTED_SHOP_COOKIE, OWNER_SESSION_COOKIE, ownerSessionCookie, selectedOwnerShopCookie } from "@/server/seller-identity/http-auth";
import { PostgresAttemptLimiter, PostgresIdentityStore } from "@/server/seller-identity/postgres-store";
import { registerOwnerAndShop } from "@/server/seller-identity/service";
import { SELLER_SESSION_COOKIE, signInSeller } from "@/server/auth/seller-session";
import { hashAccessCode } from "@/server/auth/access-code";
import { GET as readStock, PATCH as adjustStock } from "./[productId]/route";
import { PUT as setStockMode } from "./[productId]/policy/route";

const origin = "https://inventory-routes.test";
const signingSecret = "inventory-route-tests-use-a-private-secret-at-least-thirty-two-bytes";

type CreatedShop = {
  shopId: string;
  ownerId: string;
  ownerCookie: string;
};

function request(path: string, method: string, cookie?: string, body?: unknown): Request {
  return new Request(`${origin}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";", 1)[0];
}

describe("seller inventory HTTP routes with owner and legacy sessions", () => {
  let temporary: Awaited<ReturnType<typeof createTemporaryDatabase>>;
  let pool: Pool;
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
    runtimeGlobal.agentshelfDb = database.db;
    close = database.close;
    pool = (database.db as ReturnType<typeof createDb>["db"] & { $client: Pool }).$client;
    store = new PostgresIdentityStore(pool);
    limiter = new PostgresAttemptLimiter(pool, signingSecret);
    runtimeGlobal.agentshelfOwnerIdentityRuntime = { store, limiter };
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE shops, seller_identity_attempt_windows, seller_identity_operations,
      seller_agent_grants, owner_sessions, shop_memberships, seller_owners CASCADE`);
  });

  afterAll(async () => {
    runtimeGlobal.agentshelfOwnerIdentityRuntime = undefined;
    delete runtimeGlobal.agentshelfDb;
    await close?.();
    await temporary?.drop();
    delete process.env.APP_SIGNING_SECRET;
  });

  it("preserves owner and legacy session stock access without accepting a shop from the caller", async () => {
    async function createOwnerShop(username: string, slug: string): Promise<CreatedShop> {
      const result = await registerOwnerAndShop(store, limiter, {
        username,
        password: "correct horse battery staple",
        idempotencyKey: randomUUID(),
        shop: { name: `${slug} shop`, slug, location: "Riga, Latvia", currency: "EUR", timezone: "Europe/Riga" },
      }, `inventory-route-test:${username}`);
      const ownerCookie = [
        cookiePair(ownerSessionCookie(result.sessionToken, result.expiresAt)),
        cookiePair(selectedOwnerShopCookie(result.shop.id, result.expiresAt)),
      ].join("; ");
      return { shopId: result.shop.id, ownerId: result.owner.id, ownerCookie };
    }

    async function createPhysicalProduct(shopId: string, title: string): Promise<string> {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO products (shop_id, kind, status, title, price_minor)
         VALUES ($1, 'product', 'published', $2, 100) RETURNING id`,
        [shopId, title],
      );
      return result.rows[0].id;
    }

    const ownerA = await createOwnerShop("inventory-owner-a", "inventory-shop-a");
    const ownerB = await createOwnerShop("inventory-owner-b", "inventory-shop-b");
    const productA = await createPhysicalProduct(ownerA.shopId, "Shop A item");
    const productB = await createPhysicalProduct(ownerB.shopId, "Shop B item");

    const policy = await setStockMode(
      request(`/api/seller/inventory/${productA}/policy`, "PUT", ownerA.ownerCookie, {
        mode: "tracked", onHand: 3, idempotencyKey: "owner-inventory-policy-0001", reason: "Initial owner count",
      }),
      { params: Promise.resolve({ productId: productA }) },
    );
    expect(policy.status).toBe(200);
    expect(await policy.json()).toMatchObject({ productId: productA, onHand: 3, version: 0 });
    expect((await pool.query<{ actor_id: string }>(
      "SELECT actor_id FROM inventory_audit WHERE shop_id = $1 AND product_id = $2",
      [ownerA.shopId, productA],
    )).rows[0].actor_id).toBe(ownerA.ownerId);

    const adjusted = await adjustStock(
      request(`/api/seller/inventory/${productA}`, "PATCH", ownerA.ownerCookie, {
        delta: 1, expectedVersion: 0, idempotencyKey: "owner-inventory-adjust-0001", reason: "Owner counted one more",
      }),
      { params: Promise.resolve({ productId: productA }) },
    );
    expect(adjusted.status).toBe(200);
    expect(await adjusted.json()).toMatchObject({ productId: productA, onHand: 4, version: 1 });

    const foreignPolicy = await setStockMode(
      request(`/api/seller/inventory/${productB}/policy`, "PUT", ownerB.ownerCookie, {
        mode: "tracked", onHand: 5, idempotencyKey: "foreign-inventory-policy-0001", reason: "Shop B initial count",
      }),
      { params: Promise.resolve({ productId: productB }) },
    );
    expect(foreignPolicy.status).toBe(200);

    const tenantBody = await adjustStock(
      request(`/api/seller/inventory/${productA}`, "PATCH", ownerA.ownerCookie, {
        shopId: ownerB.shopId, delta: 1, expectedVersion: 1,
        idempotencyKey: "owner-inventory-forged-shop", reason: "Try another shop",
      }),
      { params: Promise.resolve({ productId: productA }) },
    );
    expect(tenantBody.status).toBe(400);

    const foreignProduct = await readStock(
      request(`/api/seller/inventory/${productB}`, "GET", ownerA.ownerCookie),
      { params: Promise.resolve({ productId: productB }) },
    );
    expect(foreignProduct.status).toBe(404);

    const foreignSelectedShop = await readStock(
      request(`/api/seller/inventory/${productB}`, "GET", [
        ownerB.ownerCookie.split("; ", 1)[0],
        `${OWNER_SELECTED_SHOP_COOKIE}=${ownerA.shopId}`,
      ].join("; ")),
      { params: Promise.resolve({ productId: productB }) },
    );
    expect(foreignSelectedShop.status).toBe(401);

    const sellerCodeHash = await hashAccessCode("legacy-shop-code");
    await pool.query("UPDATE shops SET seller_access_code_hash = $2 WHERE id = $1", [ownerA.shopId, sellerCodeHash]);
    const legacySession = await signInSeller(getDb(), { shopSlug: "inventory-shop-a", accessCode: "legacy-shop-code" });
    const legacyCookie = `${SELLER_SESSION_COOKIE}=${legacySession.token}`;
    const legacyProduct = await createPhysicalProduct(ownerA.shopId, "Legacy-session item");
    const legacyPolicy = await setStockMode(
      request(`/api/seller/inventory/${legacyProduct}/policy`, "PUT", legacyCookie, {
        mode: "untracked", idempotencyKey: "legacy-inventory-policy-0001", reason: "Seller chose untracked",
      }),
      { params: Promise.resolve({ productId: legacyProduct }) },
    );
    expect(legacyPolicy.status).toBe(200);
    expect(await legacyPolicy.json()).toMatchObject({ productId: legacyProduct, mode: "untracked", version: 0 });
    expect((await pool.query<{ actor_id: string }>(
      "SELECT actor_id FROM inventory_audit WHERE shop_id = $1 AND product_id = $2",
      [ownerA.shopId, legacyProduct],
    )).rows[0].actor_id).toBe(ownerA.shopId);

    const invalidOwnerWithLegacy = await readStock(
      request(`/api/seller/inventory/${productA}`, "GET", `${OWNER_SESSION_COOKIE}=invalid; ${legacyCookie}`),
      { params: Promise.resolve({ productId: productA }) },
    );
    expect(invalidOwnerWithLegacy.status).toBe(401);

    const unauthenticated = await readStock(
      request(`/api/seller/inventory/${productA}`, "GET"),
      { params: Promise.resolve({ productId: productA }) },
    );
    expect(unauthenticated.status).toBe(401);
  });
});
