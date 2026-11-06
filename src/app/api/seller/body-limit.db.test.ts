import { beforeEach, describe, expect, it, vi } from "vitest";

import { setupMigratedDatabase } from "../../../../test/database";
import { createShop } from "../../../../test/fixtures";
import { hashAccessCode } from "@/server/auth/access-code";
import { signInSeller } from "@/server/auth/seller-session";

import { PATCH as catalogPatch } from "./catalog/[id]/route";
import { POST as catalogSync } from "./catalog/sync/route";
import { POST as importBulk } from "./imports/[id]/bulk/route";
import { PATCH as importRowPatch } from "./imports/[id]/rows/[rowId]/route";
import { POST as signIn } from "./session/route";

// Every JSON route a browser can post to reads its body with a limit. One request with a huge body
// must not run the only web service out of memory, and the sign-in route takes it from anyone.

const getDb = setupMigratedDatabase();

const session = vi.hoisted(() => ({ token: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "agentshelf_seller_session" && session.token ? { value: session.token } : undefined,
    set: () => undefined,
  }),
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/server/db", () => ({ getDb: () => getDbForRoutes() }));

function getDbForRoutes() {
  return getDb();
}

const CHUNK = new Uint8Array(64 * 1024).fill(0x20);
const CHUNKS = 128;
const ID = "11111111-1111-4111-8111-111111111111";

// Says how much of the body was read, with no declared length, as a chunked request sends it.
function hugeRequest() {
  const read = { bytes: 0 };
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === CHUNKS) {
        controller.close();
        return;
      }
      sent += 1;
      read.bytes += CHUNK.length;
      controller.enqueue(CHUNK);
    },
  });
  const request = new Request("http://localhost/api/seller", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit);
  return { request, read };
}

const params = { params: Promise.resolve({ id: ID, rowId: ID }) };

const signedInRoutes: [string, (request: Request) => Promise<Response>][] = [
  ["a catalog edit", (request) => catalogPatch(request, params)],
  ["a catalog sync", (request) => catalogSync(request)],
  ["a bulk action", (request) => importBulk(request, params)],
  ["a row edit", (request) => importRowPatch(request, params)],
];

describe("a request body past the limit", () => {
  beforeEach(async () => {
    const shop = await createShop(getDb(), { sellerAccessCodeHash: await hashAccessCode("body-limit-code") });
    const { token } = await signInSeller(getDb(), { shopSlug: shop.slug, accessCode: "body-limit-code" });
    session.token = token;
  });

  it.each(signedInRoutes)("is not read for %s", async (_name, route) => {
    const { request, read } = hugeRequest();
    const response = await route(request);
    expect(response.status).toBe(400);
    expect(read.bytes).toBeLessThan(CHUNK.length * CHUNKS);
  });

  it("is not read for sign-in, with no session", async () => {
    session.token = undefined;
    const { request, read } = hugeRequest();
    const response = await signIn(request);
    expect(response.status).toBe(400);
    expect(read.bytes).toBeLessThan(CHUNK.length * CHUNKS);
  });

  it("is refused by its declared length before anything is read", async () => {
    session.token = undefined;
    const { request, read } = hugeRequest();
    request.headers.set("content-length", String(CHUNK.length * CHUNKS));
    const response = await signIn(request);
    expect(response.status).toBe(400);
    expect(read.bytes).toBeLessThan(CHUNK.length * 4);
  });

  it("does not change what a body within the limit gets", async () => {
    session.token = undefined;
    const answer = await signIn(
      new Request("http://localhost/api/seller/session", { method: "POST", body: "not json" }),
    );
    expect(answer.status).toBe(400);
    expect(await answer.json()).toMatchObject({ error: { code: "INVALID_INPUT" } });
  });
});
