import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTemporaryDatabase } from "../../../test/database";
import { runMigrations } from "../db/migrate";
import {
  authenticatePayPalOwner,
  consumePayPalLoginAttempt,
  createPayPalLoginAttempt,
} from "./paypal-login";
import { PostgresAttemptLimiter, PostgresIdentityStore } from "./postgres-store";
import { registerOwner, signInOwner } from "./service";

const now = new Date("2026-11-06T12:00:00.000Z");
const profile = (displayName: string, email: string) => ({ displayName, email });

describe("PayPal Login Postgres persistence", () => {
  let temporary: Awaited<ReturnType<typeof createTemporaryDatabase>>;
  let pool: Pool;
  let store: PostgresIdentityStore;
  let limiter: PostgresAttemptLimiter;

  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    await runMigrations(temporary.url);
    pool = new Pool({ connectionString: temporary.url, max: 8 });
    store = new PostgresIdentityStore(pool);
    limiter = new PostgresAttemptLimiter(pool, "paypal-login-db-test-attempt-hash-secret");
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE seller_paypal_login_states, seller_owner_paypal_identities,
      seller_identity_attempt_windows, seller_identity_operations, seller_agent_grants,
      owner_sessions, shop_memberships, seller_owners CASCADE`);
  });

  afterAll(async () => {
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
});
