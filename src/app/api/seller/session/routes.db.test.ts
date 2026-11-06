import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DELETE as deleteSellerSession, GET as getSellerSession, POST as signInSellerRoute } from "./route";
import { POST as registerOwner } from "../identity/register/route";
import { GET as getOwnerSession } from "../identity/me/route";
import { createShop } from "../../../../../test/fixtures";
import { setupMigratedDatabase } from "../../../../../test/database";
import { hashAccessCode } from "@/server/auth/access-code";
import { OWNER_SELECTED_SHOP_COOKIE, OWNER_SESSION_COOKIE } from "@/server/seller-identity/http-auth";

const cookieJar = vi.hoisted(() => ({ values: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.values.get(name);
      return value === undefined ? undefined : { value };
    },
    set: (name: string, value: string) => cookieJar.values.set(name, value),
    delete: (name: string) => cookieJar.values.delete(name),
  }),
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/server/db", () => ({ getDb: () => getDbForRoutes() }));

const getDb = setupMigratedDatabase();

function getDbForRoutes() {
  return getDb();
}

function cookieFrom(response: Response, name: string): string {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Response did not set ${name}`);
  return decodeURIComponent(cookie.slice(name.length + 1).split(";", 1)[0]);
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { Origin: "http://localhost", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function registerOwnerShop(slug: string) {
  const response = await registerOwner(jsonRequest("/api/seller/identity/register", {
    username: `owner-${slug}`,
    password: "correct horse battery staple",
    idempotencyKey: randomUUID(),
    shop: { name: `Owner ${slug}`, slug, location: "Riga, Latvia", currency: "EUR", timezone: "Europe/Riga" },
  }));
  expect(response.status).toBe(201);
  const ownerSession = cookieFrom(response, OWNER_SESSION_COOKIE);
  const selectedShop = cookieFrom(response, OWNER_SELECTED_SHOP_COOKIE);
  return { ownerSession, selectedShop };
}

describe("legacy seller session routes clear owner identity transitions", () => {
  beforeEach(() => {
    cookieJar.values.clear();
    process.env.APP_ORIGIN = "http://localhost";
    const runtime = globalThis as typeof globalThis & { agentshelfOwnerIdentityRuntime?: unknown };
    runtime.agentshelfOwnerIdentityRuntime = undefined;
  });

  it("DELETE revokes and clears owner and legacy cookies", async () => {
    const { ownerSession, selectedShop } = await registerOwnerShop("delete-transition-shop");
    cookieJar.values.set(OWNER_SESSION_COOKIE, ownerSession);
    cookieJar.values.set(OWNER_SELECTED_SHOP_COOKIE, selectedShop);
    cookieJar.values.set("agentshelf_seller_session", "preexisting-legacy-session");
    expect((await getOwnerSession(new Request("http://localhost/api/seller/identity/me", { headers: { Cookie: `${OWNER_SESSION_COOKIE}=${ownerSession}` } }))).status).toBe(200);

    const response = await deleteSellerSession();
    expect(response.status).toBe(204);
    expect(cookieJar.values.has("agentshelf_seller_session")).toBe(false);
    expect(cookieJar.values.has(OWNER_SESSION_COOKIE)).toBe(false);
    expect(cookieJar.values.has(OWNER_SELECTED_SHOP_COOKIE)).toBe(false);
    expect((await getOwnerSession(new Request("http://localhost/api/seller/identity/me", { headers: { Cookie: `${OWNER_SESSION_COOKIE}=${ownerSession}` } }))).status).toBe(401);
    expect((await getSellerSession()).status).toBe(401);
  });

  it("successful legacy sign-in revokes an old owner session while failed sign-in keeps it", async () => {
    const { ownerSession, selectedShop } = await registerOwnerShop("login-transition-shop");
    cookieJar.values.set(OWNER_SESSION_COOKIE, ownerSession);
    cookieJar.values.set(OWNER_SELECTED_SHOP_COOKIE, selectedShop);
    const legacy = await createShop(getDb(), { sellerAccessCodeHash: await hashAccessCode("login-transition-code") });

    const failed = await signInSellerRoute(jsonRequest("/api/seller/session", { shopSlug: legacy.slug, accessCode: "wrong-code" }));
    expect(failed.status).toBe(401);
    expect(cookieJar.values.get(OWNER_SESSION_COOKIE)).toBe(ownerSession);
    expect((await getOwnerSession(new Request("http://localhost/api/seller/identity/me", { headers: { Cookie: `${OWNER_SESSION_COOKIE}=${ownerSession}` } }))).status).toBe(200);

    const successful = await signInSellerRoute(jsonRequest("/api/seller/session", { shopSlug: legacy.slug, accessCode: "login-transition-code" }));
    expect(successful.status).toBe(200);
    expect(cookieJar.values.has(OWNER_SESSION_COOKIE)).toBe(false);
    expect(cookieJar.values.has(OWNER_SELECTED_SHOP_COOKIE)).toBe(false);
    expect(cookieJar.values.has("agentshelf_seller_session")).toBe(true);
    expect((await getOwnerSession(new Request("http://localhost/api/seller/identity/me", { headers: { Cookie: `${OWNER_SESSION_COOKIE}=${ownerSession}` } }))).status).toBe(401);
    const current = await getSellerSession();
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ shop: { id: legacy.id } });
  });
});
