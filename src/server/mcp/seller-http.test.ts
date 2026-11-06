import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../db", () => ({
  getDb: vi.fn(() => {
    return { $client: { query: vi.fn() } };
  }),
}));
vi.mock("../seller-identity/service", () => ({
  resolveAuthorizedSellerAgent: vi.fn().mockRejectedValue(new Error("grant is inactive or out of scope")),
  createShopForAuthorizedAgent: vi.fn(),
}));

import { handleSellerMcpRequest } from "./seller-http";
import { resolveAuthorizedSellerAgent } from "../seller-identity/service";

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

  it("requires an out-of-band bearer grant before constructing seller identity services", async () => {
    process.env.APP_ORIGIN = "https://seller.example.test";
    const response = await handleSellerMcpRequest(new Request("https://seller.example.test/mcp/seller/onboarding", {
      method: "POST",
      headers: { host: "seller.example.test", "content-type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("rejects an expired, revoked or wrong-scope grant before serving MCP capabilities", async () => {
    process.env.APP_ORIGIN = "https://seller.example.test";
    const shopId = "5f4b2190-f88b-4d19-bef6-cc11e71bb6f1";
    const response = await handleSellerMcpRequest(new Request(`https://seller.example.test/mcp/seller/shop/${shopId}`, {
      method: "POST",
      headers: { host: "seller.example.test", authorization: `Bearer ${"A".repeat(43)}`, "content-type": "application/json" },
      body: "{}",
    }), shopId);
    expect(response.status).toBe(401);
    expect(resolveAuthorizedSellerAgent).toHaveBeenCalledWith(expect.anything(), "A".repeat(43), "read_shop", shopId);
    expect(resolveAuthorizedSellerAgent).toHaveBeenCalledWith(expect.anything(), "A".repeat(43), "manage_catalog", shopId);
    expect(resolveAuthorizedSellerAgent).toHaveBeenCalledWith(expect.anything(), "A".repeat(43), "manage_inventory", shopId);
    expect(resolveAuthorizedSellerAgent).toHaveBeenCalledWith(expect.anything(), "A".repeat(43), "connect_paypal", shopId);
  });
});
