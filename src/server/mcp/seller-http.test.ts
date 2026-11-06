import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../db", () => ({
  getDb: vi.fn(() => {
    throw new Error("database must not be reached");
  }),
}));

import { handleSellerMcpRequest } from "./seller-http";

describe("seller MCP HTTP boundary", () => {
  const oldOrigin = process.env.APP_ORIGIN;

  afterEach(() => {
    if (oldOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = oldOrigin;
  });

  it("rejects a Host that does not match the configured public origin", async () => {
    process.env.APP_ORIGIN = "https://seller.example.test";
    const response = await handleSellerMcpRequest(new Request("https://seller.example.test/mcp/seller/onboarding", {
      method: "POST",
      headers: { host: "attacker.example.test", authorization: "Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    }));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Invalid Host header");
  });

  it("rejects disallowed browser origins before reading MCP bodies", async () => {
    process.env.APP_ORIGIN = "https://seller.example.test";
    const response = await handleSellerMcpRequest(new Request("https://seller.example.test/mcp/seller/onboarding", {
      method: "POST",
      headers: { host: "seller.example.test", origin: "https://attacker.example.test", authorization: "Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    }));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
  });

  it("requires an out-of-band bearer grant and does not reach the database without one", async () => {
    process.env.APP_ORIGIN = "https://seller.example.test";
    const response = await handleSellerMcpRequest(new Request("https://seller.example.test/mcp/seller/onboarding", {
      method: "POST",
      headers: { host: "seller.example.test", "content-type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });
});
