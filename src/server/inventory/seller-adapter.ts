import "server-only";

import type { Pool } from "pg";

import type { SellerShopPrincipal } from "../contracts/seller-identity";
import type { AdjustInventoryInput } from "../contracts/inventory";
import { adjustInventory, readStock, setInventoryMode } from "./postgres";
import type { StockLevel } from "./types";

export type InventoryPolicyDecision =
  | { productId: string; mode: "tracked"; onHand: number; idempotencyKey: string; reason: string }
  | { productId: string; mode: "untracked"; idempotencyKey: string; reason: string };

/**
 * PostgreSQL adapter for authenticated seller routes and seller MCP callbacks.
 * Identity resolution must happen before these methods are called; the principal is never
 * constructed from tool input. The stock service scopes every database read/write by shopId.
 */
export function createSellerInventoryAdapter(pool: Pool) {
  return {
    read(principal: SellerShopPrincipal, productId: string): Promise<StockLevel> {
      return readStock(pool, principal, productId);
    },
    adjust(principal: SellerShopPrincipal, input: AdjustInventoryInput): Promise<StockLevel> {
      return adjustInventory(pool, principal, input);
    },
    setMode(principal: SellerShopPrincipal, decision: InventoryPolicyDecision): Promise<StockLevel> {
      const { productId, ...policy } = decision;
      return setInventoryMode(pool, principal, productId, policy);
    },
  };
}
