import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { availableSellerAgentTools, createSellerMcpServer, type SellerAgentServices } from "./seller-server";

class InMemoryTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  peer?: InMemoryTransport;

  async start() {}

  async send(message: JSONRPCMessage, options?: TransportSendOptions) {
    void options;
    queueMicrotask(() => this.peer?.onmessage?.(message));
  }

  async close() {
    this.onclose?.();
  }
}

describe("seller MCP capability registration", () => {
  const minimal: SellerAgentServices = { grantTokenFromRequest: () => undefined };

  it("advertises no seller operations until backed by services and tenant authorization", () => {
    expect(availableSellerAgentTools(minimal)).toEqual([]);
    expect(availableSellerAgentTools({
      ...minimal,
      catalog: { supportedActions: ["list"], run: vi.fn() },
      authorizeShop: vi.fn(),
    })).toEqual([]);
  });

  it("registers only operations backed by adapters", () => {
    const services: SellerAgentServices = {
      ...minimal,
      identity: { createShopForAuthorizedAgent: vi.fn() },
      authorizeShop: vi.fn(),
      shopIdFromRequest: () => "5f4b2190-f88b-4d19-bef6-cc11e71bb6f1",
      stock: { read: vi.fn(), adjust: vi.fn(), setMode: vi.fn() },
      catalog: { supportedActions: ["list", "edit"], run: vi.fn() },
    };
    expect(availableSellerAgentTools(services)).toEqual(["createShop", "manageCatalog", "manageStock"]);

    const server = createSellerMcpServer(services) as unknown as { _registeredTools: Record<string, unknown> };
    expect(Object.keys(server._registeredTools).sort()).toEqual([
      "seller_create_shop",
      "seller_manage_catalog",
      "seller_manage_stock",
    ]);
  });

  it("lists and calls tools through an SDK client/server MCP protocol exchange", async () => {
    const shopId = "5f4b2190-f88b-4d19-bef6-cc11e71bb6f1";
    const authorizeShop = vi.fn(async (_token: string | undefined, _scope: string, requestedShopId: string) => ({
      shopId: requestedShopId,
      actorId: "owner-1",
    }));
    const services: SellerAgentServices = {
      ...minimal,
      grantTokenFromRequest: () => "seller-grant-test-only",
      authorizeShop,
      shopIdFromRequest: () => shopId,
      stock: {
        read: async (_principal, productId) => ({
          productId,
          mode: "tracked",
          onHand: 4,
          reserved: 1,
          available: 3,
          version: 2,
          updatedAt: "2026-11-06T10:00:00.000Z",
        }),
        adjust: async (_principal, input) => ({
          productId: input.productId,
          mode: "tracked",
          onHand: 5,
          reserved: 1,
          available: 4,
          version: 3,
          updatedAt: "2026-11-06T10:01:00.000Z",
        }),
        setMode: async (_principal, input) => ({
          productId: input.productId,
          mode: input.mode,
          onHand: input.mode === "tracked" ? (input.onHand ?? 0) : null,
          reserved: input.mode === "tracked" ? 0 : null,
          available: input.mode === "tracked" ? (input.onHand ?? 0) : null,
          version: 1,
          updatedAt: "2026-11-06T10:02:00.000Z",
        }),
      },
      catalog: {
        supportedActions: ["list"],
        run: async () => ({ products: [], paypalSync: "not_attempted" }),
      },
    };
    const client = new Client({ name: "seller-mcp-contract-test", version: "0.1.0" });
    const clientTransport = new InMemoryTransport();
    const serverTransport = new InMemoryTransport();
    clientTransport.peer = serverTransport;
    serverTransport.peer = clientTransport;
    const mcp = createSellerMcpServer(services);

    try {
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["seller_manage_catalog", "seller_manage_stock"]);
      expect(tools.tools[0]?.inputSchema.properties?.action).toMatchObject({ enum: ["list"] });

      const unsupportedCatalogAction = await client.callTool({
        name: "seller_manage_catalog",
        arguments: { action: "create", product: { kind: "product", title: "Cable", price: "5.00" } },
      });
      expect(unsupportedCatalogAction.isError).toBe(true);

      const productId = "2f4b2190-f88b-4d19-bef6-cc11e71bb6f1";
      const attemptedTenantOverride = await client.callTool({
        name: "seller_manage_stock",
        arguments: { action: "read", productId, shopId: "7f4b2190-f88b-4d19-bef6-cc11e71bb6f1" },
      });
      expect(attemptedTenantOverride.isError).toBe(true);

      const result = await client.callTool({ name: "seller_manage_stock", arguments: { action: "read", productId } });
      expect(result.structuredContent).toEqual({ productId, mode: "tracked", onHand: 4, reserved: 1, available: 3, version: 2, updatedAt: "2026-11-06T10:00:00.000Z" });
      expect(authorizeShop).toHaveBeenCalledWith("seller-grant-test-only", "read_shop", shopId);

      const adjusted = await client.callTool({
        name: "seller_manage_stock",
        arguments: { action: "adjust", productId, delta: 1, expectedVersion: 2, idempotencyKey: "stock-adjust-0001", reason: "Restocked unit" },
      });
      expect(adjusted.structuredContent).toEqual({ productId, mode: "tracked", onHand: 5, reserved: 1, available: 4, version: 3, updatedAt: "2026-11-06T10:01:00.000Z" });
      expect(authorizeShop).toHaveBeenLastCalledWith("seller-grant-test-only", "manage_inventory", shopId);
    } finally {
      await client.close();
      await mcp.close();
    }
  });

  it("returns fixed recovery guidance for known error codes without leaking service messages", async () => {
    const shopId = "5f4b2190-f88b-4d19-bef6-cc11e71bb6f1";
    const productId = "2f4b2190-f88b-4d19-bef6-cc11e71bb6f1";
    const failure = (code: string) => Object.assign(new Error(`internal detail ${code} row 42`), { code });
    const services: SellerAgentServices = {
      ...minimal,
      grantTokenFromRequest: () => "seller-grant-test-only",
      authorizeShop: vi.fn(async (_token: string | undefined, scope: string, requestedShopId: string) => {
        if (scope === "manage_catalog") throw failure("UNAUTHORIZED");
        return { shopId: requestedShopId, actorId: "owner-1" };
      }),
      shopIdFromRequest: () => shopId,
      stock: {
        read: async () => { throw failure("NOT_FOUND"); },
        adjust: async () => { throw failure("CONFLICT"); },
        setMode: async () => { throw Object.assign(new Error("database connection string leaked"), { code: "OTHER_SHOP_RECORD_EXISTS" }); },
      },
      catalog: { supportedActions: ["list"], run: vi.fn() },
    };
    const client = new Client({ name: "seller-error-guidance-test", version: "0.1.0" });
    const clientTransport = new InMemoryTransport();
    const serverTransport = new InMemoryTransport();
    clientTransport.peer = serverTransport;
    serverTransport.peer = clientTransport;
    const mcp = createSellerMcpServer(services);
    const errorBody = (response: Awaited<ReturnType<Client["callTool"]>>) => {
      expect(response.isError).toBe(true);
      const text = (response.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      if (!text.startsWith("{")) throw new Error(text);
      expect(text).not.toContain("internal detail");
      expect(text).not.toContain("leaked");
      return JSON.parse(text) as { code: string; message: string };
    };
    try {
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.find((tool) => tool.name === "seller_manage_stock")?.description).toContain("set_mode");

      const missing = errorBody(await client.callTool({ name: "seller_manage_stock", arguments: { action: "read", productId } }));
      expect(missing.code).toBe("NOT_FOUND");
      expect(missing.message).toContain("set_mode");

      const stale = errorBody(await client.callTool({
        name: "seller_manage_stock",
        arguments: { action: "adjust", productId, delta: -1, expectedVersion: 0, idempotencyKey: "stock-adjust-guidance-0002", reason: "Stale version" },
      }));
      expect(stale).toMatchObject({ code: "CONFLICT" });
      expect(stale.message).toContain("expectedVersion");

      const denied = errorBody(await client.callTool({ name: "seller_manage_catalog", arguments: { action: "list" } }));
      expect(denied.code).toBe("UNAUTHORIZED");
      expect(denied.message).toContain("scope");

      const unknown = errorBody(await client.callTool({
        name: "seller_manage_stock",
        arguments: { action: "set_mode", productId, mode: "untracked", idempotencyKey: "stock-mode-guidance-0001", reason: "Untracked item" },
      }));
      expect(unknown).toEqual({ code: "SELLER_AGENT_OPERATION_FAILED", message: "The seller operation could not be completed." });
    } finally {
      await client.close();
      await mcp.close();
    }
  });

  it("keeps owner authorization errors fixed and only returns the configured agent-access URL", async () => {
    vi.stubEnv("APP_ORIGIN", "https://seller.example.test");
    const responses = [
      Object.assign(new Error("secret grant hash and owner email"), {
        code: "AGENT_AUTHORIZATION_REQUIRED",
        authorizationUrl: "https://attacker.example/collect?grant=secret",
      }),
      Object.assign(new Error("internal authorization detail"), {
        code: "AGENT_AUTHORIZATION_REQUIRED",
        authorizationUrl: "https://seller.example.test/seller/agent-access",
      }),
    ];
    const services: SellerAgentServices = {
      ...minimal,
      identity: { createShopForAuthorizedAgent: vi.fn(async () => { throw responses.shift(); }) },
    };
    const client = new Client({ name: "seller-auth-guidance-test", version: "0.1.0" });
    const clientTransport = new InMemoryTransport();
    const serverTransport = new InMemoryTransport();
    clientTransport.peer = serverTransport;
    serverTransport.peer = clientTransport;
    const mcp = createSellerMcpServer(services);
    try {
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);
      const createShop = { name: "seller_create_shop", arguments: {
        shop: { name: "Example Shop", slug: "example-shop", location: "Riga", currency: "EUR", timezone: "Europe/Riga" },
        idempotencyKey: "9f7dd05e-55fb-4d8b-91e6-309a30d5d4b9",
      } };
      const readError = async () => {
        const response = await client.callTool(createShop);
        expect(response.isError).toBe(true);
        return JSON.parse((response.content as Array<{ text: string }>)[0].text) as {
          code: string;
          message: string;
          authorizationUrl?: string;
        };
      };

      const hostile = await readError();
      expect(hostile).toEqual({
        code: "AGENT_AUTHORIZATION_REQUIRED",
        message: "The owner must authorize this seller-agent action.",
      });

      const valid = await readError();
      expect(valid).toEqual({
        code: "AGENT_AUTHORIZATION_REQUIRED",
        message: "The owner must authorize this seller-agent action.",
        authorizationUrl: "https://seller.example.test/seller/agent-access",
      });
    } finally {
      await client.close();
      await mcp.close();
      vi.unstubAllEnvs();
    }
  });

  it("only forwards PayPal consent after the identity resolver confirms the owner grant", async () => {
    const shopId = "5f4b2190-f88b-4d19-bef6-cc11e71bb6f1";
    const shareDataConsentAt = new Date("2026-11-06T11:12:13.000Z");
    const start = vi.fn(async () => ({ connection: { shopId, status: "pending" as const }, actionUrl: "https://www.sandbox.paypal.com/merchantsignup/partner/onboardingentry?token=action-token" }));
    const services: SellerAgentServices = {
      ...minimal,
      grantTokenFromRequest: () => "seller-grant-test-only",
      authorizeShop: vi.fn(async () => ({ shopId, actorId: "owner-1", shareDataConsent: true as const, shareDataConsentAt })),
      shopIdFromRequest: () => shopId,
      paypalConnection: { start },
    };
    const client = new Client({ name: "seller-paypal-consent-test", version: "0.1.0" });
    const clientTransport = new InMemoryTransport();
    const serverTransport = new InMemoryTransport();
    clientTransport.peer = serverTransport;
    serverTransport.peer = clientTransport;
    const mcp = createSellerMcpServer(services);
    try {
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);
      const response = await client.callTool({
        name: "seller_connect_paypal",
        arguments: { action: "start", idempotencyKey: "seller-connect-0001" },
      });
      expect(response.structuredContent).toEqual({
        status: "pending",
        humanActionUrl: "https://www.sandbox.paypal.com/merchantsignup/partner/onboardingentry?token=action-token",
      });
      expect(start).toHaveBeenCalledWith(
        { shopId, actorId: "owner-1", shareDataConsent: true, shareDataConsentAt },
        { shopId, idempotencyKey: "seller-connect-0001" },
      );
    } finally {
      await client.close();
      await mcp.close();
    }
  });

  it("does not start PayPal when the resolved seller grant lacks owner data-sharing consent", async () => {
    const shopId = "5f4b2190-f88b-4d19-bef6-cc11e71bb6f1";
    const start = vi.fn();
    const services: SellerAgentServices = {
      ...minimal,
      grantTokenFromRequest: () => "seller-grant-test-only",
      authorizeShop: vi.fn(async () => ({ shopId, actorId: "owner-1" })),
      shopIdFromRequest: () => shopId,
      paypalConnection: { start },
    };
    const client = new Client({ name: "seller-paypal-no-consent-test", version: "0.1.0" });
    const clientTransport = new InMemoryTransport();
    const serverTransport = new InMemoryTransport();
    clientTransport.peer = serverTransport;
    serverTransport.peer = clientTransport;
    const mcp = createSellerMcpServer(services);
    try {
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);
      const response = await client.callTool({
        name: "seller_connect_paypal",
        arguments: { action: "start", idempotencyKey: "seller-connect-0001", shareDataConsent: true },
      });
      expect(response.isError).toBe(true);
      expect(start).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});
