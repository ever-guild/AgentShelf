import "server-only";

import {
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";

import {
  ownerAccountRegistrationInput,
  ownerCreateShopInput,
  ownerRegistrationInput,
  ownerSignInInput,
  type AuthenticatedOwner,
  type SellerPayPalShopPrincipal,
  type SellerAgentGrantPrincipal,
  type SellerAgentScope,
  type SellerShopPrincipal,
  type ShopRegistration,
} from "../contracts/seller-identity";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;
const HASH_BYTES = 32;
const SCRYPT = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const OWNER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AGENT_GRANT_TTL_MS = 15 * 60 * 1000;
// Keep registration traffic below the Postgres limiter's 1000-attempt counter ceiling.
const OWNER_REGISTRATION_CLIENT_LIMIT = 100;
const DUMMY_SALT = Buffer.from("AgentShelfPilotDummySalt", "utf8");

export type OwnerRecord = { id: string; username: string; passwordHash: string };
export type ShopRecord = {
  id: string;
  slug: string;
  name: string;
  location: string;
  currency: "EUR";
  timezone: string;
};
export type OwnerShopRegistration = {
  owner: Pick<OwnerRecord, "id" | "username">;
  shop: ShopRecord;
  role: "owner";
};

export class IdentityStoreConflict extends Error {
  constructor(message = "Identity operation conflicts with existing data") {
    super(message);
    this.name = "IdentityStoreConflict";
  }
}

function isStoreConflict(error: unknown): boolean {
  return error instanceof IdentityStoreConflict ||
    (typeof error === "object" && error !== null && "code" in error && error.code === "23505");
}

export type IdentityStore = {
  findOwnerByUsername(username: string): Promise<OwnerRecord | null>;
  findOwnerById(ownerId: string): Promise<Pick<OwnerRecord, "id" | "username"> | null>;
  /** Atomically persist an owner without requiring a shop, and safely replay the same key. */
  registerOwnerAtomic(input: {
    username: string;
    passwordHash: string;
    idempotencyKey: string;
  }): Promise<{ owner: Pick<OwnerRecord, "id" | "username">; storedPasswordHash: string; replayed: boolean }>;
  /** Must atomically enforce username/slug uniqueness, persist owner + shop + membership,
   * and replay the same result for an identical owner-registration idempotency key. */
  registerOwnerAndShopAtomic(input: {
    username: string;
    passwordHash: string;
    shop: ShopRegistration;
    idempotencyKey: string;
  }): Promise<{ registration: OwnerShopRegistration; storedPasswordHash: string; replayed: boolean }>;
  /** Must atomically enforce slug uniqueness, persist shop + owner membership, and
   * replay the same result for an identical owner-scoped key. */
  createOwnedShopAtomic(input: {
    ownerId: string;
    shop: ShopRegistration;
    idempotencyKey: string;
  }): Promise<ShopRecord>;
  listOwnerShops(ownerId: string): Promise<ShopRecord[]>;
  findOwnedShop(ownerId: string, shopId: string): Promise<ShopRecord | null>;
  createSession(input: {
    ownerId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void>;
  findActiveSession(tokenHash: string, now: Date): Promise<{
    ownerId: string;
    expiresAt: Date;
  } | null>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
  /** Persists an expiring, owner-consented grant. shopId is null only for create_shop. */
  createAgentGrant(input: {
    ownerId: string;
    shopId: string | null;
    scopes: SellerAgentScope[];
    tokenHash: string;
    expiresAt: Date;
    shareDataConsentAt: Date | null;
  }): Promise<void>;
  findActiveAgentGrant(tokenHash: string, now: Date): Promise<SellerAgentGrantPrincipal | null>;
  revokeAgentGrant(tokenHash: string, ownerId: string, now: Date): Promise<void>;
  /** Must validate active consent, bind its first successful use to one idempotency key,
   * and create/replay that owner-scoped operation atomically. */
  createAgentShopAtomic(input: {
    grantTokenHash: string;
    shop: ShopRegistration;
    idempotencyKey: string;
    now: Date;
  }): Promise<{ ownerId: string; shop: ShopRecord } | null>;
};

export type AttemptLimiter = {
  /** Shared/persistent implementations should count attempts by normalized account and IP. */
  consume(key: string, limit: number, windowMs: number, now: Date): Promise<boolean>;
};

export class IdentityError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "UNAUTHORIZED"
      | "RATE_LIMITED"
      | "REGISTRATION_CONFLICT"
      | "SHOP_SLUG_UNAVAILABLE"
      | "AGENT_AUTHORIZATION_REQUIRED",
    message: string,
    readonly authorizationUrl?: string,
  ) {
    super(message);
    this.name = "IdentityError";
  }
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new IdentityError("INVALID_INPUT", "The request is not valid.");
  }
  return result.data;
}

function validateTimezone(value: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
  } catch {
    throw new IdentityError("INVALID_INPUT", "The request is not valid.");
  }
}

function validateShop(shop: ShopRegistration): ShopRegistration {
  validateTimezone(shop.timezone);
  return shop;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, HASH_BYTES, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function verifyPassword(password: string, encoded: string | undefined): Promise<boolean> {
  const [scheme, nRaw, rRaw, pRaw, saltRaw, hashRaw, ...rest] = (encoded ?? "").split("$");
  if (
    scheme !== "scrypt" || nRaw !== String(SCRYPT.N) || rRaw !== String(SCRYPT.r) ||
    pRaw !== String(SCRYPT.p) || !saltRaw || !hashRaw || rest.length !== 0
  ) {
    await scryptAsync(password, DUMMY_SALT, HASH_BYTES, SCRYPT);
    return false;
  }
  const salt = Buffer.from(saltRaw, "base64url");
  const expected = Buffer.from(hashRaw, "base64url");
  if (salt.length !== 16 || expected.length !== HASH_BYTES) return false;
  const actual = await scryptAsync(password, salt, HASH_BYTES, SCRYPT);
  return timingSafeEqual(actual, expected);
}

function makeToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function registerOwnerAndShop(
  store: IdentityStore,
  limiter: AttemptLimiter,
  rawInput: unknown,
  clientKey: string,
  now = new Date(),
) {
  const input = parse(ownerRegistrationInput, rawInput);
  const username = input.username.toLowerCase();
  const globalAllowed = await limiter.consume(`register:${clientKey}`, OWNER_REGISTRATION_CLIENT_LIMIT, 60 * 60_000, now);
  const accountAllowed = await limiter.consume(`register-account:${username}`, 5, 60 * 60_000, now);
  if (!globalAllowed || !accountAllowed) throw new IdentityError("RATE_LIMITED", "Please try again later.");
  validateShop(input.shop);
  const passwordHash = await hashPassword(input.password);
  let result: { registration: OwnerShopRegistration; storedPasswordHash: string; replayed: boolean };
  try {
    result = await store.registerOwnerAndShopAtomic({
      username,
      passwordHash,
      shop: input.shop,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    if (isStoreConflict(error)) {
      throw new IdentityError("REGISTRATION_CONFLICT", "The account or shop could not be registered.");
    }
    throw error;
  }
  if (result.replayed && !(await verifyPassword(input.password, result.storedPasswordHash))) {
    throw new IdentityError("UNAUTHORIZED", "The registration request could not be authenticated.");
  }
  const registration = result.registration;
  return { ...registration, ...(await issueSession(store, registration.owner.id, now)) };
}

export async function registerOwner(
  store: IdentityStore,
  limiter: AttemptLimiter,
  rawInput: unknown,
  clientKey: string,
  now = new Date(),
) {
  const input = parse(ownerAccountRegistrationInput, rawInput);
  const username = input.username.toLowerCase();
  const globalAllowed = await limiter.consume(`register:${clientKey}`, OWNER_REGISTRATION_CLIENT_LIMIT, 60 * 60_000, now);
  const accountAllowed = await limiter.consume(`register-account:${username}`, 5, 60 * 60_000, now);
  if (!globalAllowed || !accountAllowed) throw new IdentityError("RATE_LIMITED", "Please try again later.");
  const passwordHash = await hashPassword(input.password);
  let result: { owner: Pick<OwnerRecord, "id" | "username">; storedPasswordHash: string; replayed: boolean };
  try {
    result = await store.registerOwnerAtomic({ username, passwordHash, idempotencyKey: input.idempotencyKey });
  } catch (error) {
    if (isStoreConflict(error)) {
      throw new IdentityError("REGISTRATION_CONFLICT", "The account could not be registered.");
    }
    throw error;
  }
  if (result.replayed && !(await verifyPassword(input.password, result.storedPasswordHash))) {
    throw new IdentityError("UNAUTHORIZED", "The registration request could not be authenticated.");
  }
  return { owner: result.owner, ...(await issueSession(store, result.owner.id, now)) };
}

async function issueSession(store: IdentityStore, ownerId: string, now: Date) {
  const token = makeToken();
  const expiresAt = new Date(now.getTime() + OWNER_SESSION_TTL_MS);
  await store.createSession({ ownerId, tokenHash: tokenHash(token), expiresAt });
  return { sessionToken: token, expiresAt };
}

export async function signInOwner(
  store: IdentityStore,
  limiter: AttemptLimiter,
  rawInput: unknown,
  clientKey: string,
  now = new Date(),
) {
  const input = parse(ownerSignInInput, rawInput);
  const username = input.username.toLowerCase();
  const allowed = await limiter.consume(`signin:${clientKey}:${username}`, 8, 15 * 60_000, now);
  if (!allowed) throw new IdentityError("RATE_LIMITED", "Please try again later.");
  const owner = await store.findOwnerByUsername(username);
  if (!(await verifyPassword(input.password, owner?.passwordHash))) {
    throw new IdentityError("UNAUTHORIZED", "Username or password is incorrect.");
  }
  if (!owner) throw new IdentityError("UNAUTHORIZED", "Username or password is incorrect.");
  return { owner: { id: owner.id, username: owner.username }, ...(await issueSession(store, owner.id, now)) };
}

export async function requireOwnerSession(
  store: IdentityStore,
  sessionToken: string | undefined,
  now = new Date(),
) {
  if (!sessionToken || sessionToken.length > 128) {
    throw new IdentityError("UNAUTHORIZED", "Sign in to continue.");
  }
  const session = await store.findActiveSession(tokenHash(sessionToken), now);
  if (!session || session.expiresAt.getTime() <= now.getTime()) {
    throw new IdentityError("UNAUTHORIZED", "Sign in to continue.");
  }
  return { ownerId: session.ownerId, expiresAt: session.expiresAt } satisfies AuthenticatedOwner;
}

/** Membership is always resolved from the authenticated owner, never from a client-supplied owner ID. */
export async function listOwnerShops(store: IdentityStore, authenticatedOwner: AuthenticatedOwner): Promise<ShopRecord[]> {
  return store.listOwnerShops(authenticatedOwner.ownerId);
}

export async function requireOwnerShop(
  store: IdentityStore,
  authenticatedOwner: AuthenticatedOwner,
  shopId: string,
): Promise<ShopRecord> {
  if (!z.uuid().safeParse(shopId).success) throw new IdentityError("UNAUTHORIZED", "This shop is not available to this account.");
  const shop = await store.findOwnedShop(authenticatedOwner.ownerId, shopId);
  if (!shop) throw new IdentityError("UNAUTHORIZED", "This shop is not available to this account.");
  return shop;
}

export async function requireSellerShopPrincipal(
  store: IdentityStore,
  authenticatedOwner: AuthenticatedOwner,
  requestedShopId: string,
): Promise<SellerShopPrincipal> {
  const shop = await requireOwnerShop(store, authenticatedOwner, requestedShopId);
  return { actorId: authenticatedOwner.ownerId, shopId: shop.id };
}

export async function signOutOwner(
  store: IdentityStore,
  sessionToken: string | undefined,
  now = new Date(),
): Promise<void> {
  if (sessionToken && sessionToken.length <= 128) {
    await store.revokeSession(tokenHash(sessionToken), now);
  }
}

export async function createOwnedShop(
  store: IdentityStore,
  authenticatedOwner: AuthenticatedOwner,
  rawInput: unknown,
) {
  const input = parse(ownerCreateShopInput, rawInput);
  validateShop(input.shop);
  try {
    const shop = await store.createOwnedShopAtomic({ ownerId: authenticatedOwner.ownerId, shop: input.shop, idempotencyKey: input.idempotencyKey });
    return { shop, paymentStatus: "not_configured" as const };
  } catch (error) {
    if (isStoreConflict(error)) {
      throw new IdentityError("SHOP_SLUG_UNAVAILABLE", "This shop could not be created with that slug.");
    }
    throw error;
  }
}

const SHOP_AGENT_SCOPES: readonly SellerAgentScope[] = [
  "read_shop",
  "manage_catalog",
  "manage_inventory",
  "connect_paypal",
];

export async function authorizeSellerAgent(
  store: IdentityStore,
  authenticatedOwner: AuthenticatedOwner,
  shopId: string | null,
  rawScopes: unknown = ["create_shop"],
  now = new Date(),
  shareDataConsent = false,
) {
  const scopesSchema = z.array(z.enum(["create_shop", "read_shop", "manage_catalog", "manage_inventory", "connect_paypal"])).min(1).max(4);
  const parsed = scopesSchema.safeParse(rawScopes);
  if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
    throw new IdentityError("INVALID_INPUT", "The requested agent permissions are not valid.");
  }
  const scopes = parsed.data;
  if (scopes.includes("connect_paypal") && !shareDataConsent) {
    throw new IdentityError("INVALID_INPUT", "PayPal data sharing requires explicit owner consent.");
  }
  if (shopId === null) {
    if (scopes.length !== 1 || scopes[0] !== "create_shop") {
      throw new IdentityError("INVALID_INPUT", "Shop management permission must name a shop.");
    }
  } else {
    if (!scopes.every((scope) => SHOP_AGENT_SCOPES.includes(scope))) {
      throw new IdentityError("INVALID_INPUT", "Shop creation permission cannot be combined with shop permissions.");
    }
    await requireOwnerShop(store, authenticatedOwner, shopId);
  }
  const token = makeToken();
  const expiresAt = new Date(now.getTime() + AGENT_GRANT_TTL_MS);
  await store.createAgentGrant({
    ownerId: authenticatedOwner.ownerId,
    shopId,
    scopes,
    tokenHash: tokenHash(token),
    expiresAt,
    shareDataConsentAt: scopes.includes("connect_paypal") ? now : null,
  });
  return { grantToken: token, shopId, scopes, expiresAt };
}

export async function revokeSellerAgent(
  store: IdentityStore,
  authenticatedOwner: AuthenticatedOwner,
  grantToken: string,
  now = new Date(),
): Promise<void> {
  await store.revokeAgentGrant(tokenHash(grantToken), authenticatedOwner.ownerId, now);
}

export function resolveAuthorizedSellerAgent(
  store: IdentityStore,
  grantToken: string | undefined,
  requiredScope: "connect_paypal",
  requestedShopId?: string,
  now?: Date,
): Promise<SellerPayPalShopPrincipal>;
export function resolveAuthorizedSellerAgent(
  store: IdentityStore,
  grantToken: string | undefined,
  requiredScope: SellerAgentScope,
  requestedShopId?: string,
  now?: Date,
): Promise<SellerShopPrincipal | { actorId: string; shopId: null }>;
export async function resolveAuthorizedSellerAgent(
  store: IdentityStore,
  grantToken: string | undefined,
  requiredScope: SellerAgentScope,
  requestedShopId?: string,
  now = new Date(),
): Promise<SellerShopPrincipal | { actorId: string; shopId: null }> {
  if (!grantToken || grantToken.length > 128) {
    throw new IdentityError("AGENT_AUTHORIZATION_REQUIRED", "The owner must authorize this seller-agent action.");
  }
  const grant = await store.findActiveAgentGrant(tokenHash(grantToken), now);
  if (!grant || !grant.scopes.includes(requiredScope)) {
    throw new IdentityError("UNAUTHORIZED", "The seller-agent authorization is invalid or expired.");
  }
  if (requiredScope === "connect_paypal" && (!grant.shareDataConsent || !grant.shareDataConsentAt)) {
    throw new IdentityError("UNAUTHORIZED", "The seller-agent authorization is invalid or expired.");
  }
  if (requiredScope === "create_shop") {
    if (grant.shopId !== null || requestedShopId !== undefined) {
      throw new IdentityError("UNAUTHORIZED", "The seller-agent authorization does not cover this shop.");
    }
    return { actorId: grant.actorId, shopId: null };
  }
  if (!grant.shopId || requestedShopId !== grant.shopId) {
    throw new IdentityError("UNAUTHORIZED", "The seller-agent authorization does not cover this shop.");
  }
  return {
    actorId: grant.actorId,
    shopId: grant.shopId,
    ...(requiredScope === "connect_paypal"
      ? { shareDataConsent: true as const, shareDataConsentAt: grant.shareDataConsentAt! }
      : {}),
  };
}

export async function createShopForAuthorizedAgent(
  store: IdentityStore,
  grantToken: string | undefined,
  rawInput: unknown,
  authorizationUrl: string,
  now = new Date(),
) {
  const input = parse(ownerCreateShopInput, rawInput);
  validateShop(input.shop);
  if (!grantToken || grantToken.length > 128) {
    throw new IdentityError("AGENT_AUTHORIZATION_REQUIRED", "The owner must authorize shop creation.", authorizationUrl);
  }
  let authorized: { ownerId: string; shop: ShopRecord } | null;
  try {
    authorized = await store.createAgentShopAtomic({
      grantTokenHash: tokenHash(grantToken),
      shop: input.shop,
      idempotencyKey: input.idempotencyKey,
      now,
    });
  } catch (error) {
    if (isStoreConflict(error)) {
      throw new IdentityError("SHOP_SLUG_UNAVAILABLE", "This shop could not be created with that slug.");
    }
    throw error;
  }
  if (!authorized) throw new IdentityError("UNAUTHORIZED", "The agent authorization is invalid or expired.");
  return { shop: authorized.shop, paymentStatus: "not_configured" as const };
}
