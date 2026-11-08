import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTemporaryDatabase } from "../../../test/database";
import { runMigrations } from "../db/migrate";
import {
  authenticatePayPalOwner,
  consumePayPalLoginAttempt,
  createPayPalLoginAttempt,
} from "./paypal-login";
import { createPayPalLoginHttpHandlers } from "./paypal-login-http";
import { PostgresAttemptLimiter, PostgresIdentityStore } from "./postgres-store";
import { registerOwner, signInOwner } from "./service";
import { GET as getOwnerMe } from "../../app/api/seller/identity/me/route";

const now = new Date("2026-11-06T12:00:00.000Z");
const profile = (displayName: string, email: string) => ({ displayName, email });
const origin = "https://paypal-login.test";

function cookiePair(response: Response, name: string): string {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Response did not set ${name}`);
  return cookie.split(";", 1)[0];
}

describe("PayPal Login Postgres persistence", () => {
  let temporary: Awaited<ReturnType<typeof createTemporaryDatabase>>;
  let pool: Pool;
  let store: PostgresIdentityStore;
  let limiter: PostgresAttemptLimiter;
  const runtimeGlobal = globalThis as typeof globalThis & {
    agentshelfOwnerIdentityRuntime?: unknown;
  };
  let previousRuntime: unknown;

  beforeAll(async () => {
    previousRuntime = runtimeGlobal.agentshelfOwnerIdentityRuntime;
    temporary = await createTemporaryDatabase();
    await runMigrations(temporary.url);
    pool = new Pool({ connectionString: temporary.url, max: 8 });
    store = new PostgresIdentityStore(pool);
    limiter = new PostgresAttemptLimiter(pool, "paypal-login-db-test-attempt-hash-secret");
    runtimeGlobal.agentshelfOwnerIdentityRuntime = { store, limiter };
    vi.stubEnv("APP_ORIGIN", origin);
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE seller_paypal_login_states, seller_owner_paypal_identities,
      seller_identity_attempt_windows, seller_identity_operations, seller_agent_grants,
      owner_sessions, shop_memberships, seller_owners CASCADE`);
  });

  afterAll(async () => {
    runtimeGlobal.agentshelfOwnerIdentityRuntime = previousRuntime;
    vi.unstubAllEnvs();
    await pool?.end();
    await temporary?.drop();
  });

  it("serializes concurrent first logins into one owner identity and creates no shop", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        authenticatePayPalOwner(store, {
          subject: "sandbox-subject-001",
          profile: profile("First Profile", "shared@example.test"),
        }, now),
      ),
    );

    expect(new Set(results.map((result) => result.owner.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.every((result) => result.shops.length === 0)).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS n FROM seller_owners")).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM seller_owner_paypal_identities")).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM shops")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM paypal_merchant_connections")).rows[0].n).toBe(0);
  });

  it("updates the returning profile without relinking accounts by matching email", async () => {
    const first = await authenticatePayPalOwner(store, {
      subject: "sandbox-returning-subject",
      profile: profile("Old Name", "same@example.test"),
    }, now);
    const returning = await authenticatePayPalOwner(store, {
      subject: "sandbox-returning-subject",
      profile: profile("Updated Name", "same@example.test"),
    }, new Date(now.getTime() + 1_000));
    const differentSubject = await authenticatePayPalOwner(store, {
      subject: "sandbox-different-subject",
      profile: profile("Different Account", "same@example.test"),
    }, new Date(now.getTime() + 2_000));

    expect(returning.owner.id).toBe(first.owner.id);
    expect(returning.created).toBe(false);
    expect(returning.owner.paypalProfile).toEqual(profile("Updated Name", "same@example.test"));
    expect(differentSubject.owner.id).not.toBe(first.owner.id);
    expect((await pool.query("SELECT count(*)::int AS n FROM seller_owner_paypal_identities")).rows[0].n).toBe(2);
    expect((await pool.query("SELECT count(*)::int AS n FROM shops")).rows[0].n).toBe(0);
  });

  it("rejects password sign-in for PayPal-only identities and retains password sign-in", async () => {
    const paypalOwner = await authenticatePayPalOwner(store, {
      subject: "passwordless-paypal-subject",
      profile: profile("PayPal Owner", "owner@example.test"),
    }, now);
    const passwordlessRecord = await store.findOwnerByUsername(paypalOwner.owner.username);
    expect(passwordlessRecord?.passwordHash).toBeNull();
    await expect(signInOwner(store, limiter, {
      username: paypalOwner.owner.username,
      password: "some password that cannot apply",
    }, "paypal-login-db-test", now)).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const passwordOwner = await registerOwner(store, limiter, {
      username: "passwordowner",
      password: "correct horse battery staple",
      idempotencyKey: randomUUID(),
    }, "paypal-login-db-test", now);
    const signedIn = await signInOwner(store, limiter, {
      username: "passwordowner",
      password: "correct horse battery staple",
    }, "password-sign-in-test", new Date(now.getTime() + 1_000));
    expect(signedIn.owner.id).toBe(passwordOwner.owner.id);
  });

  it("binds state to the browser, rejects expired or replayed state, and permits only one concurrent consume", async () => {
    const bound = await createPayPalLoginAttempt(store, now);
    expect(await consumePayPalLoginAttempt(store, bound.state, `${bound.browserBinding}-wrong`, new Date(now.getTime() + 1))).toBe(false);
    expect(await consumePayPalLoginAttempt(store, bound.state, bound.browserBinding, new Date(now.getTime() + 2))).toBe(true);
    expect(await consumePayPalLoginAttempt(store, bound.state, bound.browserBinding, new Date(now.getTime() + 3))).toBe(false);

    const expired = await createPayPalLoginAttempt(store, now);
    expect(await consumePayPalLoginAttempt(store, expired.state, expired.browserBinding, expired.expiresAt)).toBe(false);

    const concurrent = await createPayPalLoginAttempt(store, now);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () =>
      consumePayPalLoginAttempt(store, concurrent.state, concurrent.browserBinding, new Date(now.getTime() + 4)),
    ));
    expect(outcomes.filter(Boolean)).toHaveLength(1);

    const storedState = await pool.query<{ state_hash: string; browser_binding_hash: string }>(
      "SELECT state_hash, browser_binding_hash FROM seller_paypal_login_states WHERE expires_at > $1",
      [now],
    );
    expect(storedState.rows.every((row) => ![bound.state, bound.browserBinding, expired.state, concurrent.state, concurrent.browserBinding].includes(row.state_hash))).toBe(true);
    expect(storedState.rows.every((row) => ![bound.state, bound.browserBinding, expired.state, concurrent.state, concurrent.browserBinding].includes(row.browser_binding_hash))).toBe(true);
  });

  it("persists callback sessions accepted by the next /me request for new and returning owners", async () => {
    const callbackNow = new Date();
    const env = {
      APP_ORIGIN: origin,
      PAYPAL_LOGIN_CLIENT_ID: "test-login-client-id",
      PAYPAL_LOGIN_CLIENT_SECRET: "test-login-client-secret",
    };
    let tokenCalls = 0;
    const tokenGrants: URLSearchParams[] = [];
    let userInfoAuthorization: string | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/v1/oauth2/token")) {
        const grant = new URLSearchParams(String(init?.body));
        tokenGrants.push(grant);
        tokenCalls += 1;
        if (tokenCalls % 2 === 1) {
          return Response.json({ access_token: "test-initial-access-token", refresh_token: "test-refresh-token", token_type: "Bearer", expires_in: 300 });
        }
        return Response.json({ access_token: "test-refreshed-access-token", token_type: "Bearer", expires_in: 300 });
      }
      userInfoAuthorization = new Headers(init?.headers).get("authorization");
      return Response.json({ sub: "stable-disposable-pg-subject", name: "PG Test Owner", email: "pg-owner@example.test" });
    };
    const handlers = createPayPalLoginHttpHandlers({ store, limiter, env, fetchImpl, now: () => callbackNow });

    const startAndCallback = async () => {
      const previousTokenCalls = tokenCalls;
      const previousGrantCount = tokenGrants.length;
      const started = await handlers.start(new Request(`${origin}/api/seller/identity/paypal/start`, {
        headers: { "cf-connecting-ip": "203.0.113.40" },
      }));
      expect(started.status).toBe(303);
      const authorization = new URL(started.headers.get("location")!);
      const stateCookie = cookiePair(started, "agentshelf_paypal_login_state");
      const callback = await handlers.callback(new Request(
        `${origin}/api/seller/identity/paypal/callback?code=test-code&state=${authorization.searchParams.get("state")}`,
        { headers: { cookie: stateCookie } },
      ));
      expect(callback.status).toBe(303);
      expect(tokenCalls - previousTokenCalls).toBe(2);
      expect(tokenGrants.slice(previousGrantCount).map((grant) => Object.fromEntries(grant.entries()))).toEqual([
        { grant_type: "authorization_code", code: "test-code" },
        { grant_type: "refresh_token", refresh_token: "test-refresh-token" },
      ]);
      expect(userInfoAuthorization).toBe("Bearer test-refreshed-access-token");
      const ownerCookie = cookiePair(callback, "agentshelf_owner_session");
      const me = await getOwnerMe(new Request(`${origin}/api/seller/identity/me`, { headers: { cookie: ownerCookie } }));
      return { callback, ownerCookie, me };
    };

    const first = await startAndCallback();
    expect(tokenCalls).toBe(2);
    expect(first.callback.headers.get("location")).toBe(`${origin}/seller/paypal-onboarding`);
    expect(first.me.status).toBe(200);
    expect(first.me.headers.get("cache-control")).toBe("no-store");
    const firstProfile = await first.me.json() as {
      owner: { id: string; username: string; paypalProfile: { displayName: string; email: string } };
      shops: unknown[];
      selectedShopId: string | null;
    };
    expect(firstProfile.owner.paypalProfile).toEqual({ displayName: "PG Test Owner", email: "pg-owner@example.test" });
    expect(firstProfile.shops).toEqual([]);
    expect(firstProfile.selectedShopId).toBeNull();

    const shop = await store.createOwnedShopAtomic({
      ownerId: firstProfile.owner.id,
      shop: { name: "Returning Seller Shop", slug: "returning-seller-shop", location: "Riga, Latvia", currency: "EUR", timezone: "Europe/Riga" },
      idempotencyKey: randomUUID(),
    });
    expect(shop.id).toBeTruthy();

    const returning = await startAndCallback();
    expect(tokenCalls).toBe(4);
    expect(returning.ownerCookie).not.toBe(first.ownerCookie);
    expect(returning.callback.headers.get("location")).toBe(`${origin}/seller/shops`);
    expect(returning.me.status).toBe(200);
    const returningProfile = await returning.me.json() as {
      owner: { id: string; paypalProfile: { displayName: string; email: string } };
      shops: Array<{ id: string }>;
      selectedShopId: string | null;
    };
    expect(returningProfile.owner.id).toBe(firstProfile.owner.id);
    expect(returningProfile.owner.paypalProfile).toEqual({ displayName: "PG Test Owner", email: "pg-owner@example.test" });
    expect(returningProfile.shops.map(({ id }) => id)).toEqual([shop.id]);
    expect(returningProfile.selectedShopId).toBeNull();
  });
});
