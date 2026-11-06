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

  it("only forwards PayPal consent after the identity resolver confirms the owner grant", async () => {
    const shopId = "5f4b2190-f88b-4d19-bef6-cc11e71bb6f1";
    const start = vi.fn(async () => ({ connection: { shopId, status: "pending" as const }, actionUrl: "https://www.sandbox.paypal.com/merchantsignup/partner/onboardingentry?token=action-token" }));
    const services: SellerAgentServices = {
      ...minimal,
      grantTokenFromRequest: () => "seller-grant-test-only",
      authorizeShop: vi.fn(async () => ({ shopId, actorId: "owner-1", shareDataConsent: true as const })),
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
        { shopId, actorId: "owner-1", shareDataConsent: true },
        { shopId, idempotencyKey: "seller-connect-0001", shareDataConsent: true },
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
