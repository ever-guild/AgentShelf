import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { createDb } from "@/server/db/client";
import { createTemporaryDatabase } from "../../../../../test/database";
import { POST as register } from "./register/route";
import { POST as signIn } from "./sign-in/route";
import { POST as signOut } from "./sign-out/route";
import { GET as me } from "./me/route";
import { POST as createShop } from "./shops/route";
import { POST as selectShop } from "./shops/select/route";
import { POST as issueGrant } from "./agent-grants/route";
import { POST as revokeGrant } from "./agent-grants/revoke/route";
import { resolveAuthorizedSellerAgent } from "@/server/seller-identity/service";
import { ownerIdentityRuntime } from "@/server/seller-identity/runtime";

const origin = "https://identity.test";

function mutation(path: string, body: unknown, cookie?: string, requestOrigin = origin): Request {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      Origin: requestOrigin,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function cookieFrom(response: Response, name: string): string {
  const header = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  if (!header) throw new Error(`Response did not set ${name}`);
  return header.split(";", 1)[0];
}

describe("seller identity HTTP routes with disposable Postgres", () => {
  let temporary: Awaited<ReturnType<typeof createTemporaryDatabase>>;
  let pool: Pool;
  let close: (() => Promise<void>) | undefined;
  const runtimeGlobal = globalThis as typeof globalThis & {
    agentshelfDb?: ReturnType<typeof createDb>["db"];
    agentshelfOwnerIdentityRuntime?: unknown;
  };

  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    const db = createDb(temporary.url);
    runtimeGlobal.agentshelfDb = db.db;
    close = db.close;
    runtimeGlobal.agentshelfOwnerIdentityRuntime = undefined;
    pool = (db.db as ReturnType<typeof createDb>["db"] & { $client: Pool }).$client;
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
    const draft = await readFile(new URL("../../../../../drizzle/drafts/identity-registration.sql", import.meta.url), "utf8");
    await pool.query(draft);
    process.env.APP_ORIGIN = origin;
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE seller_identity_attempt_windows, seller_identity_operations, seller_agent_grants, owner_sessions, shop_memberships, seller_owners, shops CASCADE`);
  });

  afterAll(async () => {
    runtimeGlobal.agentshelfOwnerIdentityRuntime = undefined;
    delete runtimeGlobal.agentshelfDb;
    await close?.();
    await temporary?.drop();
  });

  it("registers an account before the first shop, creates an owned shop, selects it, and revokes owner sessions", async () => {
    const registered = await register(mutation("/api/seller/identity/register", {
      username: "RouteOwner",
      password: "correct horse battery staple",
      idempotencyKey: randomUUID(),
    }));
    expect(registered.status).toBe(201);
    expect(registered.headers.get("cache-control")).toBe("no-store");
    const ownerCookie = cookieFrom(registered, "agentshelf_owner_session");
    expect(registered.headers.getSetCookie().some((value) => value.startsWith("agentshelf_owner_shop="))).toBe(false);
    expect(await registered.json()).toMatchObject({ owner: { username: "routeowner" }, shops: [], selectedShopId: null });

    const created = await createShop(mutation("/api/seller/identity/shops", {
      shop: { name: "Route Shop", slug: "route-shop", location: "Riga, Latvia", currency: "EUR", timezone: "Europe/Riga" },
      idempotencyKey: randomUUID(),
    }, ownerCookie));
    expect(created.status).toBe(201);
    const shopResult = await created.json() as { shop: { id: string }; paymentStatus: string };
    expect(shopResult.paymentStatus).toBe("not_configured");
    const selectedCookie = cookieFrom(created, "agentshelf_owner_shop");
    const meResponse = await me(new Request(`${origin}/api/seller/identity/me`, { headers: { Cookie: `${ownerCookie}; ${selectedCookie}` } }));
    expect(meResponse.status).toBe(200);
    expect(await meResponse.json()).toMatchObject({ owner: { username: "routeowner" }, selectedShopId: shopResult.shop.id });

    const selected = await selectShop(mutation("/api/seller/identity/shops/select", { shopId: shopResult.shop.id }, ownerCookie));
    expect(selected.status).toBe(200);
    const signOutResponse = await signOut(mutation("/api/seller/identity/sign-out", {}, ownerCookie));
    expect(signOutResponse.status).toBe(204);
    expect(signOutResponse.headers.getSetCookie()).toHaveLength(2);
    expect((await me(new Request(`${origin}/api/seller/identity/me`, { headers: { Cookie: ownerCookie } }))).status).toBe(401);
    expect((await selectShop(mutation("/api/seller/identity/shops/select", { shopId: shopResult.shop.id }, ownerCookie))).status).toBe(401);
  });

  it("rejects cross-origin mutations and persists PayPal grant consent, scope binding, and revocation", async () => {
    const crossOrigin = await register(mutation("/api/seller/identity/register", {
      username: "blockedowner",
      password: "correct horse battery staple",
      idempotencyKey: randomUUID(),
    }, undefined, "https://attacker.test"));
    expect(crossOrigin.status).toBe(401);

    const registered = await register(mutation("/api/seller/identity/register", {
      username: "grantowner",
      password: "correct horse battery staple",
      idempotencyKey: randomUUID(),
      shop: { name: "Grant Shop", slug: "grant-shop", location: "Riga, Latvia", currency: "EUR", timezone: "Europe/Riga" },
    }));
    const ownerCookie = cookieFrom(registered, "agentshelf_owner_session");
    const registeredBody = await registered.json() as { shops: Array<{ id: string }> };
    const shopIdActual = registeredBody.shops[0].id;
    const noConsent = await issueGrant(mutation("/api/seller/identity/agent-grants", {
      shopId: shopIdActual,
      scopes: ["connect_paypal"],
    }, ownerCookie));
    expect(noConsent.status).toBe(400);

    const granted = await issueGrant(mutation("/api/seller/identity/agent-grants", {
      shopId: shopIdActual,
      scopes: ["connect_paypal", "read_shop"],
      shareDataConsent: true,
    }, ownerCookie));
    expect(granted.status).toBe(201);
    const grant = await granted.json() as { grantToken: string };
    const store = ownerIdentityRuntime().store;
    await expect(resolveAuthorizedSellerAgent(store, grant.grantToken, "connect_paypal", shopIdActual)).resolves.toMatchObject({ shopId: shopIdActual, shareDataConsent: true });

    const wrongShop = await issueGrant(mutation("/api/seller/identity/agent-grants", {
      shopId: randomUUID(), scopes: ["read_shop"],
    }, ownerCookie));
    expect(wrongShop.status).toBe(401);

    const revoked = await revokeGrant(mutation("/api/seller/identity/agent-grants/revoke", { grantToken: grant.grantToken }, ownerCookie));
    expect(revoked.status).toBe(204);
    await expect(resolveAuthorizedSellerAgent(store, grant.grantToken, "connect_paypal", shopIdActual)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("signs in only with valid credentials and rotates the owner session", async () => {
    const registration = await register(mutation("/api/seller/identity/register", {
      username: "loginowner",
      password: "correct horse battery staple",
      idempotencyKey: randomUUID(),
    }));
    const priorCookie = cookieFrom(registration, "agentshelf_owner_session");
    const failed = await signIn(mutation("/api/seller/identity/sign-in", { username: "loginowner", password: "incorrect password" }));
    expect(failed.status).toBe(401);
    const successful = await signIn(mutation("/api/seller/identity/sign-in", { username: "LOGINOWNER", password: "correct horse battery staple" }, priorCookie));
    expect(successful.status).toBe(200);
    const nextCookie = cookieFrom(successful, "agentshelf_owner_session");
    expect(nextCookie).not.toBe(priorCookie);
    expect((await me(new Request(`${origin}/api/seller/identity/me`, { headers: { Cookie: priorCookie } }))).status).toBe(401);
    expect((await me(new Request(`${origin}/api/seller/identity/me`, { headers: { Cookie: nextCookie } }))).status).toBe(200);
  });
});
