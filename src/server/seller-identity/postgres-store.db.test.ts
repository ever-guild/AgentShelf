import { readFile } from "node:fs/promises";
import { createHmac, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ShopRegistration } from "../contracts/seller-identity";
import { createTemporaryDatabase } from "../../../test/database";
import { PostgresAttemptLimiter, PostgresIdentityStore } from "./postgres-store";
import { registerOwner, registerOwnerAndShop } from "./service";

describe("Postgres seller identity store", () => {
  let temporary: Awaited<ReturnType<typeof createTemporaryDatabase>>;
  let pool: Pool;
  let store: PostgresIdentityStore;
  let limiter: PostgresAttemptLimiter;
  const passwordHash = `scrypt$16384$8$1$${"A".repeat(22)}$${"B".repeat(43)}`;

  const shop = (slug: string): ShopRegistration => ({
    name: "Test Repair Shop",
    slug,
    location: "Liepaja, Latvia",
    currency: "EUR",
    timezone: "Europe/Riga",
  });

  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new Pool({ connectionString: temporary.url, max: 8 });
    await pool.query(`
      CREATE TABLE shops (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug text NOT NULL UNIQUE,
        name text NOT NULL,
        location text,
        currency text NOT NULL,
        timezone text NOT NULL,
        paypal_credential_ref text NOT NULL,
        paypal_merchant_id text,
        seller_access_code_hash text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const draft = await readFile(new URL("../../../drizzle/drafts/identity-registration.sql", import.meta.url), "utf8");
    await pool.query(draft);
    store = new PostgresIdentityStore(pool);
    limiter = new PostgresAttemptLimiter(pool, "test-only-attempt-key-hash-secret-32b");
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE seller_identity_attempt_windows, seller_identity_operations, seller_agent_grants, owner_sessions, shop_memberships, seller_owners, shops CASCADE`);
  });

  afterAll(async () => {
    await pool?.end();
    await temporary?.drop();
  });

  it("atomically creates an owner, unconfigured shop and owner membership, and safely replays the same key", async () => {
    const idempotencyKey = randomUUID();
    const request = { username: "alice", passwordHash, shop: shop("alice-shop"), idempotencyKey };
    const first = await store.registerOwnerAndShopAtomic(request);
    const retry = await store.registerOwnerAndShopAtomic(request);
    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.registration).toEqual(first.registration);
    expect((await store.listOwnerShops(first.registration.owner.id)).map(({ id }) => id)).toEqual([first.registration.shop.id]);
    const shopRow = await pool.query("SELECT paypal_credential_ref, paypal_merchant_id FROM shops WHERE id = $1", [first.registration.shop.id]);
    expect(shopRow.rows[0]).toEqual({ paypal_credential_ref: "UNCONFIGURED", paypal_merchant_id: null });
    await expect(store.registerOwnerAndShopAtomic({ ...request, shop: shop("different-shop") })).rejects.toBeTruthy();
  });

  it("registers an owner without a shop and authorizes creation of the first shop", async () => {
    const request = { username: "firstowner", passwordHash, idempotencyKey: randomUUID() };
    const first = await store.registerOwnerAtomic(request);
    const replay = await store.registerOwnerAtomic(request);
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.owner).toEqual(first.owner);
    expect(await store.listOwnerShops(first.owner.id)).toEqual([]);

    const tokenHash = "e".repeat(64);
    const expiresAt = new Date("2026-12-01T00:00:00.000Z");
    const now = new Date("2026-11-30T23:00:00.000Z");
    await store.createAgentGrant({ ownerId: first.owner.id, shopId: null, scopes: ["create_shop"], tokenHash, expiresAt, shareDataConsentAt: null });
    const created = await store.createAgentShopAtomic({ grantTokenHash: tokenHash, shop: shop("first-agent-shop"), idempotencyKey: randomUUID(), now });
    expect(created?.shop.slug).toBe("first-agent-shop");
    expect(await store.listOwnerShops(first.owner.id)).toMatchObject([{ slug: "first-agent-shop" }]);
  });

  it("rolls back failed duplicate-slug registration without claiming the existing shop", async () => {
    const first = await store.registerOwnerAndShopAtomic({ username: "first", passwordHash, shop: shop("same-slug"), idempotencyKey: randomUUID() });
    await expect(store.registerOwnerAndShopAtomic({ username: "second", passwordHash, shop: shop("same-slug"), idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "23505" });
    const counts = await pool.query(`SELECT (SELECT count(*)::int FROM seller_owners) owners, (SELECT count(*)::int FROM shops) shops, (SELECT count(*)::int FROM shop_memberships) memberships`);
    expect(counts.rows[0]).toEqual({ owners: 1, shops: 1, memberships: 1 });
    expect(await store.findOwnedShop(first.registration.owner.id, first.registration.shop.id)).toMatchObject({ slug: "same-slug" });
  });

  it("serializes concurrent same-key retries and prevents concurrent slug claims", async () => {
    const sameKey = randomUUID();
    const sameRequest = { username: "racer", passwordHash, shop: shop("one-race"), idempotencyKey: sameKey };
    const sameKeyResults = await Promise.all([store.registerOwnerAndShopAtomic(sameRequest), store.registerOwnerAndShopAtomic(sameRequest)]);
    expect(sameKeyResults.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    expect((await pool.query("SELECT count(*)::int AS n FROM shops WHERE slug='one-race'")).rows[0].n).toBe(1);

    const contenders = ["racer-a", "racer-b"].map((username) => store.registerOwnerAndShopAtomic({
      username,
      passwordHash,
      shop: shop("contended-slug"),
      idempotencyKey: randomUUID(),
    }));
    const outcomes = await Promise.allSettled(contenders);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM seller_owners WHERE username LIKE 'racer-%'")).rows[0].n).toBe(1);
  });

  it("persists session expiry, revocation and membership-scoped agent grant resolution", async () => {
    const owner = await store.registerOwnerAndShopAtomic({ username: "owner", passwordHash, shop: shop("owner-shop"), idempotencyKey: randomUUID() });
    const unrelated = await store.registerOwnerAndShopAtomic({ username: "unrelated", passwordHash, shop: shop("unrelated-shop"), idempotencyKey: randomUUID() });
    const sessionHash = "a".repeat(64);
    const expiresAt = new Date("2026-12-01T00:00:00.000Z");
    await store.createSession({ ownerId: owner.registration.owner.id, tokenHash: sessionHash, expiresAt });
    expect(await store.findActiveSession(sessionHash, new Date("2026-11-30T23:00:00.000Z"))).toMatchObject({ ownerId: owner.registration.owner.id });
    expect(await store.findActiveSession(sessionHash, expiresAt)).toBeNull();
    await store.revokeSession(sessionHash, new Date("2026-11-30T22:00:00.000Z"));
    expect(await store.findActiveSession(sessionHash, new Date("2026-11-30T22:01:00.000Z"))).toBeNull();

    const grantHash = "b".repeat(64);
    await store.createAgentGrant({ ownerId: owner.registration.owner.id, shopId: owner.registration.shop.id, scopes: ["read_shop", "manage_inventory"], tokenHash: grantHash, expiresAt, shareDataConsentAt: null });
    expect(await store.findActiveAgentGrant(grantHash, new Date("2026-11-30T23:00:00.000Z"))).toMatchObject({ actorId: owner.registration.owner.id, shopId: owner.registration.shop.id, scopes: ["read_shop", "manage_inventory"], shareDataConsent: false });
    await expect(store.createAgentGrant({ ownerId: owner.registration.owner.id, shopId: "99999999-9999-4999-8999-999999999999", scopes: ["manage_inventory"], tokenHash: "c".repeat(64), expiresAt, shareDataConsentAt: null })).rejects.toBeTruthy();
    await store.revokeAgentGrant(grantHash, unrelated.registration.owner.id, new Date("2026-11-30T22:00:00.000Z"));
    expect(await store.findActiveAgentGrant(grantHash, new Date("2026-11-30T22:01:00.000Z"))).not.toBeNull();
    await store.revokeAgentGrant(grantHash, owner.registration.owner.id, new Date("2026-11-30T22:00:00.000Z"));
    expect(await store.findActiveAgentGrant(grantHash, new Date("2026-11-30T22:01:00.000Z"))).toBeNull();

    await expect(store.createAgentGrant({ ownerId: owner.registration.owner.id, shopId: owner.registration.shop.id, scopes: ["connect_paypal"], tokenHash: "f".repeat(64), expiresAt, shareDataConsentAt: null })).rejects.toMatchObject({ code: "23514" });
    await store.createAgentGrant({ ownerId: owner.registration.owner.id, shopId: owner.registration.shop.id, scopes: ["connect_paypal"], tokenHash: "1".repeat(64), expiresAt, shareDataConsentAt: new Date("2026-11-30T21:00:00.000Z") });
    expect(await store.findActiveAgentGrant("1".repeat(64), new Date("2026-11-30T23:00:00.000Z"))).toMatchObject({ shareDataConsent: true });
  });

  it("allows one agent shop operation with same-key replay and rejects a second operation", async () => {
    const owner = await store.registerOwnerAndShopAtomic({ username: "agentowner", passwordHash, shop: shop("initial-shop"), idempotencyKey: randomUUID() });
    const grantTokenHash = "d".repeat(64);
    const expiresAt = new Date("2026-12-01T00:00:00.000Z");
    const now = new Date("2026-11-30T23:00:00.000Z");
    await store.createAgentGrant({ ownerId: owner.registration.owner.id, shopId: null, scopes: ["create_shop"], tokenHash: grantTokenHash, expiresAt, shareDataConsentAt: null });
    const input = { grantTokenHash, shop: shop("agent-created-shop"), idempotencyKey: randomUUID(), now };
    const first = await store.createAgentShopAtomic(input);
    expect(first?.shop.slug).toBe("agent-created-shop");
    expect(await store.createAgentShopAtomic(input)).toEqual(first);
    expect(await store.createAgentShopAtomic({ ...input, shop: shop("second-agent-shop"), idempotencyKey: randomUUID() })).toBeNull();
    const grant = await pool.query("SELECT consumed_at, consumed_idempotency_key FROM seller_agent_grants WHERE token_hash=$1", [grantTokenHash]);
    expect(grant.rows[0].consumed_idempotency_key).toBe(input.idempotencyKey);
    expect(grant.rows[0].consumed_at).toBeInstanceOf(Date);
  });

  it("enforces a shared bounded attempt window", async () => {
    const now = new Date("2026-11-06T12:00:00.000Z");
    expect(await limiter.consume("signin:test", 2, 60_000, now)).toBe(true);
    expect(await limiter.consume("signin:test", 2, 60_000, new Date(now.getTime() + 1))).toBe(true);
    expect(await limiter.consume("signin:test", 2, 60_000, new Date(now.getTime() + 2))).toBe(false);
    expect(await limiter.consume("signin:test", 2, 60_000, new Date(now.getTime() + 60_001))).toBe(true);
  });

  it.each([
    ["owner-only registration", false],
    ["owner-and-shop registration", true],
  ] as const)("rejects registration at the client limit and resets after one hour (%s)", async (_label, withShop) => {
    const now = new Date("2026-11-06T12:00:00.000Z");
    const clientKey = `registration-limit-${withShop ? "shop" : "owner"}`;
    const globalKeyHash = createHmac("sha256", "test-only-attempt-key-hash-secret-32b")
      .update(`register:${clientKey}`)
      .digest("hex");
    await pool.query(
      `INSERT INTO seller_identity_attempt_windows (key_hash, window_started_at, attempts) VALUES ($1, $2, 100)`,
      [globalKeyHash, now],
    );

    const register = (at: Date) => withShop
      ? registerOwnerAndShop(store, limiter, {
        username: "limitshopowner",
        password: "correct horse battery staple",
        shop: shop("limit-shop-owner-shop"),
        idempotencyKey: randomUUID(),
      }, clientKey, at)
      : registerOwner(store, limiter, {
        username: "limitowner",
        password: "correct horse battery staple",
        idempotencyKey: randomUUID(),
      }, clientKey, at);

    await expect(register(new Date(now.getTime() + 1))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect((await pool.query("SELECT attempts FROM seller_identity_attempt_windows WHERE key_hash=$1", [globalKeyHash])).rows[0].attempts).toBe(101);

    const afterWindow = new Date(now.getTime() + 60 * 60_000 + 1);
    await expect(register(afterWindow)).resolves.toBeTruthy();
    expect((await pool.query("SELECT attempts FROM seller_identity_attempt_windows WHERE key_hash=$1", [globalKeyHash])).rows[0].attempts).toBe(1);
  });
});
