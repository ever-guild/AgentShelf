import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponse } from "./http";

afterEach(() => {
  vi.restoreAllMocks();
});

const PRIVATE = "PRIVATE-PHOTO-CONTENT";

function failedQuery() {
  const cause = Object.assign(new Error(`invalid input syntax: "${PRIVATE}"`), { code: "22021" });
  return new DrizzleQueryError("insert into import_sources values ($1)", [PRIVATE], cause);
}

describe("an unexpected error", () => {
  it("is logged without the query's parameters", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = errorResponse(failedQuery());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Something went wrong." },
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual([
      "Request failed",
      { error: "Error", code: "22021" },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(PRIVATE);
  });

  it("is logged by name when it is not a database failure", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    errorResponse(new TypeError(PRIVATE));
    errorResponse(PRIVATE);
    expect(log.mock.calls).toEqual([
      ["Request failed", { error: "TypeError" }],
      ["Request failed", { error: "unknown" }],
    ]);
  });
});
