import { describe, expect, it } from "vitest";

import { adjustInventoryBody, adjustInventoryInput, inventoryLines, setInventoryModeBody } from "./inventory";

const productA = "00000000-0000-4000-8000-000000000001";
const productB = "00000000-0000-4000-8000-000000000002";

describe("inventory contracts", () => {
  it("accepts only positive integer cart quantities and unique product lines", () => {
    expect(inventoryLines.safeParse([{ productId: productA, quantity: 1 }]).success).toBe(true);
    expect(inventoryLines.safeParse([{ productId: productA, quantity: 0 }]).success).toBe(false);
    expect(inventoryLines.safeParse([{ productId: productA, quantity: 1.5 }]).success).toBe(false);
    expect(inventoryLines.safeParse([
      { productId: productA, quantity: 1 },
      { productId: productA, quantity: 2 },
    ]).success).toBe(false);
  });

  it("requires reason, version and idempotency key for manual adjustments", () => {
    const valid = { productId: productB, delta: -1, expectedVersion: 4, idempotencyKey: "a-valid-idempotency-key", reason: "Damaged item" };
    expect(adjustInventoryInput.safeParse(valid).success).toBe(true);
    expect(adjustInventoryInput.safeParse({ ...valid, expectedVersion: undefined }).success).toBe(false);
    expect(adjustInventoryInput.safeParse({ ...valid, reason: "" }).success).toBe(false);
    expect(adjustInventoryInput.safeParse({ ...valid, delta: 0 }).success).toBe(false);
    expect(adjustInventoryInput.safeParse({ ...valid, shopId: productA }).success).toBe(false);
    expect(adjustInventoryBody.safeParse({ delta: 1, expectedVersion: 0, idempotencyKey: "a-valid-idempotency-key", reason: "Restock" }).success).toBe(true);
    expect(adjustInventoryBody.safeParse({ delta: 1, expectedVersion: 0, idempotencyKey: "a-valid-idempotency-key", reason: "Restock", shopId: productA }).success).toBe(false);
  });

  it("requires an explicit initial inventory choice with a reason and idempotency key", () => {
    const key = "initial-inventory-decision-01";
    expect(setInventoryModeBody.safeParse({ mode: "tracked", onHand: 0, idempotencyKey: key, reason: "Counted zero" }).success).toBe(true);
    expect(setInventoryModeBody.safeParse({ mode: "untracked", idempotencyKey: key, reason: "Seller does not count units" }).success).toBe(true);
    expect(setInventoryModeBody.safeParse({ mode: "tracked", idempotencyKey: key, reason: "Counted zero" }).success).toBe(false);
    expect(setInventoryModeBody.safeParse({ mode: "untracked", idempotencyKey: key, reason: "Seller does not count units", onHand: 0 }).success).toBe(false);
  });
});
