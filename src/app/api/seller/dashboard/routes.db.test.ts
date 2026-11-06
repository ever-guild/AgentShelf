import { beforeEach, describe, expect, it, vi } from "vitest";

import { setupMigratedDatabase } from "../../../../../test/database";
import { createOrder, createShop } from "../../../../../test/fixtures";
import { hashAccessCode } from "@/server/auth/access-code";
import { SELLER_SESSION_COOKIE, signInSeller } from "@/server/auth/seller-session";

import { GET as bookings } from "./bookings/route";
import { GET as demand } from "./demand/route";
import { GET as orders } from "./orders/route";
import { GET as payments } from "./payments/route";

// The routes themselves, with a real session against real Postgres. Only Next.js's request context
// and the app's database handle are replaced.

const getDb = setupMigratedDatabase();

const session = vi.hoisted(() => ({ token: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "agentshelf_seller_session" && session.token ? { value: session.token } : undefined,
  }),
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/server/db", () => ({ getDb: () => getDbForRoutes() }));

function getDbForRoutes() {
  return getDb();
}

const ROUTES = { orders, payments, bookings, demand };
const NAMES = Object.keys(ROUTES) as (keyof typeof ROUTES)[];

const request = (name: string, query = "") => new Request(`http://localhost/api/seller/dashboard/${name}${query}`);

async function signedInShop(code: string) {
  const shop = await createShop(getDb(), { sellerAccessCodeHash: await hashAccessCode(code) });
  const { token } = await signInSeller(getDb(), { shopSlug: shop.slug, accessCode: code });
  return { shop, token };
}

beforeEach(() => {
  session.token = undefined;
});

describe("the dashboard's dataset routes", () => {
  it("uses the expected session cookie name", () => {
    expect(SELLER_SESSION_COOKIE).toBe("agentshelf_seller_session");
  });

  it.each(NAMES)("%s answers 401 with no session or a forged one", async (name) => {
    const shop = await createShop(getDb());
    await createOrder(getDb(), shop.id);

    const none = await ROUTES[name](request(name));
    expect(none.status).toBe(401);
    expect(await none.text()).not.toContain(shop.id);

    session.token = "forged.token";
    expect((await ROUTES[name](request(name))).status).toBe(401);
  });

  it.each(NAMES)("%s answers for the session's shop, whatever the request names", async (name) => {
    const mine = await signedInShop("mine-access-code");
    const theirs = await signedInShop("their-access-code");
    await createOrder(getDb(), theirs.shop.id, { totalMinor: 4242 });
    session.token = mine.token;

    const response = await ROUTES[name](request(name));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body.shopId).toBe(mine.shop.id);
    expect(JSON.stringify(body)).not.toContain("4242");

    const naming = await ROUTES[name](request(name, `?shopId=${theirs.shop.id}`));
    expect(naming.status).toBe(400);
    expect(await naming.text()).not.toContain("4242");

    session.token = theirs.token;
    expect((await (await ROUTES[name](request(name))).json()).shopId).toBe(theirs.shop.id);
  });

  it.each(NAMES)("%s takes a period and refuses one it does not offer", async (name) => {
    const { token } = await signedInShop("period-access-code");
    session.token = token;

    expect((await (await ROUTES[name](request(name, "?days=7"))).json()).periodDays).toBe(7);
    expect((await ROUTES[name](request(name, "?days=9"))).status).toBe(400);
  });

  it("does not show a failure's detail", async () => {
    const { token } = await signedInShop("failure-access-code");
    session.token = token;
    const failing = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = getDb();
    const select = vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error("connection to secret-host failed");
    });

    // The first select is the session's own, so it fails before any dataset runs.
    const response = await orders(request("orders"));

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret-host");
    select.mockRestore();
    failing.mockRestore();
  });
});
