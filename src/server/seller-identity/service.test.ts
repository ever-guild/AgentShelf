import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { ShopRegistration } from "../contracts/seller-identity";
import {
  authorizeSellerAgent,
  createOwnedShop,
  createShopForAuthorizedAgent,
  listOwnerShops,
  registerOwnerAndShop,
  requireOwnerShop,
  requireSellerShopPrincipal,
  resolveAuthorizedSellerAgent,
  requireOwnerSession,
  revokeSellerAgent,
  signInOwner,
  signOutOwner,
  type AttemptLimiter,
  type IdentityStore,
  type OwnerRecord,
  type OwnerShopRegistration,
  type ShopRecord,
} from "./service";
import { IdentityStoreConflict } from "./service";

class TestStore implements IdentityStore {
  owners = new Map<string, OwnerRecord>();
  shops = new Map<string, ShopRecord>();
  memberships = new Map<string, string>();
  sessions = new Map<string, { ownerId: string; expiresAt: Date; revokedAt?: Date }>();
  grants = new Map<string, { ownerId: string; shopId: string | null; scopes: import("../contracts/seller-identity").SellerAgentScope[]; expiresAt: Date; revokedAt?: Date; usedKey?: string }>();
  registrationKeys = new Map<string, { registration: OwnerShopRegistration; requestKey: string }>();
  shopKeys = new Map<string, ShopRecord>();
  agentShopKeys = new Map<string, { ownerId: string; shop: ShopRecord }>();

  async findOwnerByUsername(username: string) {
    return [...this.owners.values()].find((owner) => owner.username === username) ?? null;
  }
  async registerOwnerAndShopAtomic(input: { username: string; passwordHash: string; shop: ShopRegistration; idempotencyKey: string }) {
    const requestKey = JSON.stringify({ username: input.username, shop: input.shop });
    const prior = this.registrationKeys.get(input.idempotencyKey);
    if (prior) {
      if (prior.requestKey !== requestKey) throw new IdentityStoreConflict("idempotency conflict");
      return { registration: prior.registration, storedPasswordHash: this.owners.get(prior.registration.owner.id)!.passwordHash, replayed: true };
    }
    if (await this.findOwnerByUsername(input.username) || [...this.shops.values()].some((shop) => shop.slug === input.shop.slug)) throw new IdentityStoreConflict("unique constraint");
    const owner = { id: randomUUID(), username: input.username, passwordHash: input.passwordHash };
    const shop = { id: randomUUID(), ...input.shop };
    this.owners.set(owner.id, owner);
    this.shops.set(shop.id, shop);
    this.memberships.set(`${owner.id}:${shop.id}`, shop.id);
    const result = { owner: { id: owner.id, username: owner.username }, shop, role: "owner" as const };
    this.registrationKeys.set(input.idempotencyKey, { registration: result, requestKey });
    return { registration: result, storedPasswordHash: owner.passwordHash, replayed: false };
  }
  async createOwnedShopAtomic(input: { ownerId: string; shop: ShopRegistration; idempotencyKey: string }) {
    const key = `${input.ownerId}:${input.idempotencyKey}`;
    const prior = this.shopKeys.get(key);
    if (prior) return prior;
    if (!this.owners.has(input.ownerId) || [...this.shops.values()].some((shop) => shop.slug === input.shop.slug)) throw new IdentityStoreConflict("not owner or unique constraint");
    const shop = { id: randomUUID(), ...input.shop };
    this.shops.set(shop.id, shop);
    this.memberships.set(`${input.ownerId}:${shop.id}`, shop.id);
    this.shopKeys.set(key, shop);
    return shop;
  }
  async listOwnerShops(ownerId: string) {
    return [...this.memberships.entries()].filter(([key]) => key.startsWith(`${ownerId}:`)).map(([, id]) => this.shops.get(id)!);
  }
  async findOwnedShop(ownerId: string, shopId: string) {
    const id = this.memberships.get(`${ownerId}:${shopId}`);
    return id ? this.shops.get(id) ?? null : null;
  }
  async createSession(input: { ownerId: string; tokenHash: string; expiresAt: Date }) {
    this.sessions.set(input.tokenHash, { ownerId: input.ownerId, expiresAt: input.expiresAt });
  }
  async findActiveSession(key: string, now: Date) {
    const row = this.sessions.get(key);
    return row && !row.revokedAt && row.expiresAt > now ? row : null;
  }
  async revokeSession(key: string, now: Date) {
    const row = this.sessions.get(key);
    if (row) row.revokedAt = now;
  }
  async createAgentGrant(input: { ownerId: string; shopId: string | null; scopes: import("../contracts/seller-identity").SellerAgentScope[]; tokenHash: string; expiresAt: Date }) {
    if (input.shopId && !this.memberships.has(`${input.ownerId}:${input.shopId}`)) throw new Error("not a member");
    this.grants.set(input.tokenHash, { ownerId: input.ownerId, shopId: input.shopId, scopes: input.scopes, expiresAt: input.expiresAt });
  }
  async findActiveAgentGrant(key: string, now: Date) {
    const row = this.grants.get(key);
    return row && !row.revokedAt && row.expiresAt > now ? { actorId: row.ownerId, shopId: row.shopId, scopes: row.scopes, expiresAt: row.expiresAt } : null;
  }
  async revokeAgentGrant(key: string, ownerId: string, now: Date) {
    const row = this.grants.get(key);
    if (row?.ownerId === ownerId) row.revokedAt = now;
  }
  async createAgentShopAtomic(input: { grantTokenHash: string; shop: ShopRegistration; idempotencyKey: string; now: Date }) {
    const grant = this.grants.get(input.grantTokenHash);
    if (!grant || grant.revokedAt || grant.expiresAt <= input.now) return null;
    if (grant.usedKey && grant.usedKey !== input.idempotencyKey) return null;
    const key = `${grant.ownerId}:${input.idempotencyKey}`;
    const prior = this.agentShopKeys.get(key);
    if (prior) return prior;
    if ([...this.shops.values()].some((shop) => shop.slug === input.shop.slug)) throw new IdentityStoreConflict("unique constraint");
    const shop = { id: randomUUID(), ...input.shop };
    this.shops.set(shop.id, shop);
    this.memberships.set(`${grant.ownerId}:${shop.id}`, shop.id);
    const result = { ownerId: grant.ownerId, shop };
    grant.usedKey = input.idempotencyKey;
    this.agentShopKeys.set(key, result);
    return result;
  }
}

class TestLimiter implements AttemptLimiter {
  blocked = false;
  async consume() { return !this.blocked; }
}

const input = (slug: string, idempotencyKey = randomUUID()) => ({
  username: "ShopOwner",
  password: "correct horse battery staple",
  shop: { name: "Repair Shop", slug, location: "Liepaja, Latvia", currency: "EUR" as const, timezone: "Europe/Riga" },
  idempotencyKey,
});

describe("seller identity service", () => {
  it("registers owner, membership and shop through the atomic store contract, then authenticates", async () => {
    const store = new TestStore();
    const limiter = new TestLimiter();
    const registrationInput = input("repair-shop");
    const created = await registerOwnerAndShop(store, limiter, registrationInput, "ip:127.0.0.1", new Date("2026-11-06T12:00:00Z"));
    expect(created.role).toBe("owner");
    expect(created.owner.username).toBe("shopowner");
    expect(created.shop.slug).toBe("repair-shop");
    expect(created.owner).not.toHaveProperty("passwordHash");
    expect(created).not.toHaveProperty("paypalMerchantId");
    const replay = await registerOwnerAndShop(store, limiter, registrationInput, "ip:127.0.0.1");
    expect(replay.owner.id).toBe(created.owner.id);
    expect(replay.shop.id).toBe(created.shop.id);
    expect(store.shops).toHaveProperty("size", 1);
    await expect(registerOwnerAndShop(store, limiter, { ...registrationInput, password: "wrong password on replay" }, "ip:127.0.0.1")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(requireOwnerSession(store, created.sessionToken, new Date("2026-11-06T12:01:00Z"))).resolves.toMatchObject({ ownerId: created.owner.id });
    const signedIn = await signInOwner(store, limiter, { username: "SHOPOWNER", password: input("unused").password }, "ip:127.0.0.1");
    expect(signedIn.owner.id).toBe(created.owner.id);
  });

  it("rejects wrong credentials, expired/revoked sessions, invalid timezone and rate-limited attempts", async () => {
    const store = new TestStore();
    const limiter = new TestLimiter();
    const created = await registerOwnerAndShop(store, limiter, input("repair-shop"), "ip:test", new Date("2026-11-06T12:00:00Z"));
    await expect(signInOwner(store, limiter, { username: "shopowner", password: "wrong" }, "ip:test")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(requireOwnerSession(store, created.sessionToken, created.expiresAt)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await signOutOwner(store, created.sessionToken, new Date("2026-11-06T12:01:00Z"));
    await expect(requireOwnerSession(store, created.sessionToken)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(registerOwnerAndShop(store, limiter, { ...input("another-shop"), shop: { ...input("another-shop").shop, timezone: "Mars/Olympus" } }, "ip:test")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    limiter.blocked = true;
    await expect(registerOwnerAndShop(store, limiter, input("blocked-shop"), "ip:test")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("never claims an existing slug and returns an idempotent owned-shop result", async () => {
    const store = new TestStore();
    const limiter = new TestLimiter();
    const ownerA = await registerOwnerAndShop(store, limiter, input("first-shop"), "ip:a");
    const ownerB = await registerOwnerAndShop(store, limiter, { ...input("second-shop"), username: "otherOwner" }, "ip:b");
    const authenticatedOwner = { ownerId: ownerA.owner.id, expiresAt: ownerA.expiresAt };
    await expect(requireOwnerShop(store, authenticatedOwner, ownerB.shop.id)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(requireSellerShopPrincipal(store, authenticatedOwner, ownerA.shop.id)).resolves.toEqual({ actorId: ownerA.owner.id, shopId: ownerA.shop.id });
    expect(await listOwnerShops(store, authenticatedOwner)).toHaveLength(1);
    const idempotencyKey = randomUUID();
    const shopInput = { shop: { ...input("shared-slug").shop }, idempotencyKey };
    const authenticatedOwnerA = { ownerId: ownerA.owner.id, expiresAt: ownerA.expiresAt };
    const first = await createOwnedShop(store, authenticatedOwnerA, shopInput);
    const retry = await createOwnedShop(store, authenticatedOwnerA, shopInput);
    expect(first).toEqual(retry);
    expect(first.paymentStatus).toBe("not_configured");
    await expect(createOwnedShop(store, { ownerId: ownerB.owner.id, expiresAt: ownerB.expiresAt }, shopInput)).rejects.toMatchObject({ code: "SHOP_SLUG_UNAVAILABLE" });
  });

  it("requires owner authorization for agent creation and supports expiry, revocation and retries", async () => {
    const store = new TestStore();
    const limiter = new TestLimiter();
    const owner = await registerOwnerAndShop(store, limiter, input("owner-shop"), "ip:a", new Date("2026-11-06T12:00:00Z"));
    const request = { shop: { ...input("agent-shop").shop }, idempotencyKey: randomUUID() };
    await expect(createShopForAuthorizedAgent(store, undefined, request, "https://example.test/seller/authorize", new Date("2026-11-06T12:01:00Z"))).rejects.toMatchObject({ code: "AGENT_AUTHORIZATION_REQUIRED", authorizationUrl: "https://example.test/seller/authorize" });
    const grant = await authorizeSellerAgent(store, { ownerId: owner.owner.id, expiresAt: owner.expiresAt }, null, ["create_shop"], new Date("2026-11-06T12:01:00Z"));
    const created = await createShopForAuthorizedAgent(store, grant.grantToken, request, "https://example.test/seller/authorize", new Date("2026-11-06T12:02:00Z"));
    const retry = await createShopForAuthorizedAgent(store, grant.grantToken, request, "https://example.test/seller/authorize", new Date("2026-11-06T12:03:00Z"));
    expect(created).toEqual(retry);
    await expect(createShopForAuthorizedAgent(store, grant.grantToken, { ...request, idempotencyKey: randomUUID() }, "https://example.test/seller/authorize", new Date("2026-11-06T12:03:30Z"))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await revokeSellerAgent(store, { ownerId: owner.owner.id, expiresAt: owner.expiresAt }, grant.grantToken, new Date("2026-11-06T12:04:00Z"));
    await expect(createShopForAuthorizedAgent(store, grant.grantToken, { ...request, idempotencyKey: randomUUID() }, "https://example.test/seller/authorize", new Date("2026-11-06T12:05:00Z"))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(createShopForAuthorizedAgent(store, grant.grantToken, request, "https://example.test/seller/authorize", grant.expiresAt)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("issues management grants only for owned shops and resolves exact scope and tenant", async () => {
    const store = new TestStore();
    const limiter = new TestLimiter();
    const owner = await registerOwnerAndShop(store, limiter, input("owned-shop"), "ip:a", new Date("2026-11-06T12:00:00Z"));
    const other = await registerOwnerAndShop(store, limiter, { ...input("other-shop"), username: "otherOwner" }, "ip:b", new Date("2026-11-06T12:00:00Z"));
    const authOwner = { ownerId: owner.owner.id, expiresAt: owner.expiresAt };
    await expect(authorizeSellerAgent(store, authOwner, other.shop.id, ["manage_inventory"])).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const grant = await authorizeSellerAgent(store, authOwner, owner.shop.id, ["read_shop", "manage_inventory"], new Date("2026-11-06T12:01:00Z"));
    await expect(resolveAuthorizedSellerAgent(store, grant.grantToken, "manage_inventory", owner.shop.id, new Date("2026-11-06T12:02:00Z"))).resolves.toEqual({ actorId: owner.owner.id, shopId: owner.shop.id });
    await expect(resolveAuthorizedSellerAgent(store, grant.grantToken, "manage_catalog", owner.shop.id, new Date("2026-11-06T12:02:00Z"))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(resolveAuthorizedSellerAgent(store, grant.grantToken, "read_shop", other.shop.id, new Date("2026-11-06T12:02:00Z"))).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(resolveAuthorizedSellerAgent(store, grant.grantToken, "read_shop", owner.shop.id, grant.expiresAt)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
