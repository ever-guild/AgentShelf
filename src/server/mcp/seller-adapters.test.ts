import { describe, expect, it, vi } from "vitest";

const inventory = vi.hoisted(() => ({
  readStock: vi.fn(),
  adjustInventory: vi.fn(),
  setInventoryMode: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../inventory/postgres", () => inventory);

import type { Db } from "../db/client";
import type { IdentityStore } from "../seller-identity/service";
import { createSellerAgentServices } from "./seller-adapters";
import { availableSellerAgentTools } from "./seller-server";

describe("seller MCP route capabilities", () => {
  const dependencies = {
    db: {} as Db,
    identity: {} as IdentityStore,
    grantTokenFromRequest: () => undefined,
  };

  it("exposes only owner-level shop creation at the onboarding endpoint", () => {
    const services = createSellerAgentServices(dependencies);
    expect(availableSellerAgentTools(services)).toEqual(["createShop"]);
  });

  it("exposes management tools only when a shop was selected by the route", () => {
    const services = createSellerAgentServices({
      ...dependencies,
      shopId: "5f4b2190-f88b-4d19-bef6-cc11e71bb6f1",
      allowShopCreation: false,
    });
    expect(availableSellerAgentTools(services)).toEqual([
      "importPriceList",
      "reviewImport",
      "manageCatalog",
      "manageStock",
      "connectPayPal",
    ]);
  });

  it("removes the MCP action discriminator before calling the strict stock service", async () => {
    const pool = { query: vi.fn() };
    const db = { $client: pool } as unknown as Db;
    const services = createSellerAgentServices({ ...dependencies, db, shopId: "5f4b2190-f88b-4d19-bef6-cc11e71bb6f1" });
    const principal = { actorId: "owner-1", shopId: "5f4b2190-f88b-4d19-bef6-cc11e71bb6f1" };
    const input = {
      action: "adjust" as const,
      productId: "2f4b2190-f88b-4d19-bef6-cc11e71bb6f1",
      delta: -1,
      expectedVersion: 2,
      idempotencyKey: "qa-stock-decrement-001",
      reason: "Smoke checks one unit decrement",
    };
    inventory.adjustInventory.mockResolvedValue({
      productId: input.productId,
      mode: "tracked",
      onHand: 1,
      reserved: 0,
      available: 1,
      version: 3,
      updatedAt: new Date("2026-11-06T10:00:00.000Z"),
    });

    const result = await services.stock!.adjust(principal, input);

    expect(inventory.adjustInventory).toHaveBeenCalledWith(pool, principal, {
      productId: input.productId,
      delta: input.delta,
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
    });
    expect(result.updatedAt).toBe("2026-11-06T10:00:00.000Z");
  });
});
