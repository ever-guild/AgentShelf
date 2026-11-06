import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import { createShop } from "../../../test/fixtures";
import { searchEvents } from "@/server/db/schema";
import { MAX_RECORDED_SEARCHES } from "@/server/mcp/caller-limits";

import { POST } from "./route";

const getDb = setupMigratedDatabase();

vi.mock("@/server/db", () => ({ getDb: () => getDbForRoutes() }));

function getDbForRoutes() {
  return getDb();
}

const search = (caller: string, query: string) =>
  POST(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-forwarded-for": caller,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_products", arguments: { query } },
      }),
    }),
  );

async function recordedFor(query: string) {
  const rows = await getDb().select().from(searchEvents).where(eq(searchEvents.queryNormalized, query));
  return rows.length;
}

describe("the public MCP route", () => {
  it("stops recording one caller's searches as demand past its limit, and still answers them", async () => {
    await createShop(getDb());
    for (let call = 0; call < MAX_RECORDED_SEARCHES; call += 1) {
      const response = await search("198.51.100.7", "magsafe");
      expect(response.status).toBe(200);
    }
    expect(await recordedFor("magsafe")).toBe(MAX_RECORDED_SEARCHES);

    const past = await search("198.51.100.7", "magsafe");
    expect(past.status).toBe(200);
    const answer = (await past.json()) as { result: { isError?: boolean; structuredContent: unknown } };
    expect(answer.result.isError).toBeFalsy();
    expect(answer.result.structuredContent).toMatchObject({ products: [] });
    expect(await recordedFor("magsafe")).toBe(MAX_RECORDED_SEARCHES);

    // Another caller's demand still counts.
    await search("198.51.100.8", "magsafe");
    expect(await recordedFor("magsafe")).toBe(MAX_RECORDED_SEARCHES + 1);
  }, 60_000);
});
