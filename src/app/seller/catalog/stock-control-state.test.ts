import { describe, expect, it } from "vitest";

import {
  MISSING_INVENTORY_RECORD_MESSAGE,
  classifyInventoryReadResult,
  formatSellerProductStockSummary,
  isInventoryConflictFailure,
  resolveIdempotencyKey,
  validateAdjustFormInput,
  validatePolicyFormInput,
} from "./stock-control-state";

describe("stock-control-state", () => {
  describe("classifyInventoryReadResult", () => {
    it("classifies a valid tracked stock payload as ready", () => {
      const result = classifyInventoryReadResult(200, {
        productId: "00000000-0000-4000-8000-000000000001",
        mode: "tracked",
        onHand: 5,
        reserved: 1,
        available: 4,
        version: 2,
        updatedAt: "2026-11-08T18:00:00.000Z",
      });
      expect(result).toEqual({
        status: "ready",
        stock: {
          productId: "00000000-0000-4000-8000-000000000001",
          mode: "tracked",
          onHand: 5,
          reserved: 1,
          available: 4,
          version: 2,
          updatedAt: "2026-11-08T18:00:00.000Z",
        },
      });
    });

    it("classifies a valid untracked stock payload as ready (including reserved: 0 from Postgres)", () => {
      const result = classifyInventoryReadResult(200, {
        productId: "00000000-0000-4000-8000-000000000001",
        mode: "untracked",
        onHand: null,
        reserved: 0,
        available: null,
        version: 0,
        updatedAt: "2026-11-08T18:00:00.000Z",
      });
      expect(result.status).toBe("ready");
    });

    it("classifies only confirmed 404 NOT_FOUND with missing inventory record message as undecided", () => {
      const undecided = classifyInventoryReadResult(404, {
        error: {
          code: "NOT_FOUND",
          message: MISSING_INVENTORY_RECORD_MESSAGE,
        },
      });
      expect(undecided).toEqual({ status: "undecided" });

      const missingProduct = classifyInventoryReadResult(404, {
        error: {
          code: "NOT_FOUND",
          message: "Product was not found in this shop.",
        },
      });
      expect(missingProduct).toEqual({
        status: "error",
        message: "Product was not found in this shop.",
      });

      const genericHtml404 = classifyInventoryReadResult(404, null);
      expect(genericHtml404).toEqual({
        status: "error",
        message: "Could not load stock status (HTTP 404).",
      });
    });

    it("classifies 401 as unauthorized and 500 as error", () => {
      expect(classifyInventoryReadResult(401, {})).toEqual({
        status: "unauthorized",
      });
      expect(
        classifyInventoryReadResult(500, {
          error: { code: "INTERNAL", message: "Database unavailable." },
        }),
      ).toEqual({
        status: "error",
        message: "Database unavailable.",
      });
    });
  });

  describe("validatePolicyFormInput", () => {
    it("requires explicit mode selection and rejects empty mode", () => {
      expect(
        validatePolicyFormInput({
          mode: "",
          onHandRaw: "3",
          reasonRaw: "Initial stock",
        }),
      ).toEqual({
        ok: false,
        error: "Select whether to track quantity or leave stock untracked.",
      });
    });

    it("accepts tracked mode with integer onHand >= 0 including 0", () => {
      expect(
        validatePolicyFormInput({
          mode: "tracked",
          onHandRaw: "0",
          reasonRaw: "Initial zero stock",
        }),
      ).toEqual({
        ok: true,
        value: { mode: "tracked", onHand: 0, reason: "Initial zero stock" },
        signature: "policy:tracked:0:Initial zero stock",
      });

      expect(
        validatePolicyFormInput({
          mode: "tracked",
          onHandRaw: "12",
          reasonRaw: "  Counted on shelf  ",
        }),
      ).toEqual({
        ok: true,
        value: { mode: "tracked", onHand: 12, reason: "Counted on shelf" },
        signature: "policy:tracked:12:Counted on shelf",
      });
    });

    it("rejects negative or non-integer onHand for tracked mode", () => {
      expect(
        validatePolicyFormInput({
          mode: "tracked",
          onHandRaw: "-1",
          reasonRaw: "Initial count",
        }).ok,
      ).toBe(false);
      expect(
        validatePolicyFormInput({
          mode: "tracked",
          onHandRaw: "2.5",
          reasonRaw: "Initial count",
        }).ok,
      ).toBe(false);
    });

    it("accepts untracked mode without onHand", () => {
      expect(
        validatePolicyFormInput({
          mode: "untracked",
          onHandRaw: "",
          reasonRaw: "Made to order",
        }),
      ).toEqual({
        ok: true,
        value: { mode: "untracked", reason: "Made to order" },
        signature: "policy:untracked:Made to order",
      });
    });
  });

  describe("validateAdjustFormInput", () => {
    it("accepts positive and negative non-zero integer deltas with expectedVersion", () => {
      expect(
        validateAdjustFormInput({
          deltaRaw: "+4",
          reasonRaw: "Restock shipment",
          expectedVersion: 3,
        }),
      ).toEqual({
        ok: true,
        value: { delta: 4, expectedVersion: 3, reason: "Restock shipment" },
        signature: "adjust:3:4:Restock shipment",
      });

      expect(
        validateAdjustFormInput({
          deltaRaw: "-2",
          reasonRaw: "Damaged box",
          expectedVersion: 3,
        }),
      ).toEqual({
        ok: true,
        value: { delta: -2, expectedVersion: 3, reason: "Damaged box" },
        signature: "adjust:3:-2:Damaged box",
      });
    });

    it("rejects zero or decimal delta", () => {
      expect(
        validateAdjustFormInput({
          deltaRaw: "0",
          reasonRaw: "No-op",
          expectedVersion: 0,
        }).ok,
      ).toBe(false);
      expect(
        validateAdjustFormInput({
          deltaRaw: "1.5",
          reasonRaw: "Fraction",
          expectedVersion: 0,
        }).ok,
      ).toBe(false);
    });
  });

  describe("resolveIdempotencyKey & isInventoryConflictFailure", () => {
    it("reuses key for identical signature and rotates when signature changes", () => {
      let counter = 0;
      const createKey = () => `idem-key-${++counter}`;

      const first = resolveIdempotencyKey(null, "adjust:1:2:Restock", createKey);
      expect(first.key).toBe("idem-key-1");

      const retrySame = resolveIdempotencyKey(
        first.nextState,
        "adjust:1:2:Restock",
        createKey,
      );
      expect(retrySame.key).toBe("idem-key-1");

      const changedVersion = resolveIdempotencyKey(
        retrySame.nextState,
        "adjust:2:2:Restock",
        createKey,
      );
      expect(changedVersion.key).toBe("idem-key-2");
    });

    it("detects HTTP 409 or CONFLICT code", () => {
      expect(
        isInventoryConflictFailure(409, {
          error: { code: "CONFLICT", message: "Inventory changed" },
        }),
      ).toBe(true);
      expect(isInventoryConflictFailure(500, { error: { code: "INTERNAL" } })).toBe(
        false,
      );
    });
  });

  describe("formatSellerProductStockSummary", () => {
    it("never reports available when stock decision is required or available count is 0", () => {
      expect(
        formatSellerProductStockSummary("available", { status: "undecided" }),
      ).toBe("Stock decision required");

      expect(
        formatSellerProductStockSummary("available", {
          status: "ready",
          stock: {
            productId: "p1",
            mode: "tracked",
            onHand: 1,
            reserved: 1,
            available: 0,
            version: 1,
            updatedAt: "2026-11-08T18:00:00.000Z",
          },
        }),
      ).toBe("Out of stock · 0 available (1 on hand, 1 reserved)");
    });
  });
});
