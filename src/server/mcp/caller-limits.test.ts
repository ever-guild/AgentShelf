import { describe, expect, it } from "vitest";

import { callerOf, createCallerCounter, LIMIT_WINDOW_MS } from "./caller-limits";

const request = (headers: Record<string, string>) =>
  new Request("http://localhost/mcp", { method: "POST", headers });

describe("a caller's limit", () => {
  it("allows up to the limit in a window, per caller", () => {
    const take = createCallerCounter(2, () => 0);
    expect([take("a"), take("a"), take("a")]).toEqual([true, true, false]);
    expect(take("b")).toBe(true);
  });

  it("starts again in the next window", () => {
    let now = 0;
    const take = createCallerCounter(1, () => now);
    expect([take("a"), take("a")]).toEqual([true, false]);
    now = LIMIT_WINDOW_MS - 1;
    expect(take("a")).toBe(false);
    now = LIMIT_WINDOW_MS;
    expect(take("a")).toBe(true);
  });

  it("does not grow without bound under made-up callers", () => {
    const take = createCallerCounter(1, () => 0, 3);
    for (const caller of ["a", "b", "c", "d"]) {
      expect(take(caller)).toBe(true);
    }
    // The fourth caller started a fresh count, so the first is forgotten.
    expect(take("a")).toBe(true);
    expect(take("d")).toBe(false);
  });
});

describe("who is calling", () => {
  it("prefers what the edge states over what a client can append to", () => {
    expect(callerOf(request({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" }))).toBe(
      "203.0.113.9",
    );
    expect(callerOf(request({ "true-client-ip": "203.0.113.8", "x-forwarded-for": "198.51.100.1" }))).toBe(
      "203.0.113.8",
    );
  });

  it("falls back to the first forwarded address", () => {
    expect(callerOf(request({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" }))).toBe("198.51.100.1");
  });

  it("puts every caller it cannot tell apart in one count", () => {
    expect(callerOf(request({}))).toBe("unknown");
  });
});
