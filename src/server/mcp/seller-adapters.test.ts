import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

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
});
