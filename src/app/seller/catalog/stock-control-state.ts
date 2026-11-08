import type { StockLevel } from "@/server/inventory/types";

export const MISSING_INVENTORY_RECORD_MESSAGE = "Inventory record was not found.";

export type SellerStockPayload = Omit<StockLevel, "updatedAt"> & {
  updatedAt: string | Date;
};

export type StockControlViewState =
  | { status: "loading" }
  | { status: "undecided" }
  | { status: "ready"; stock: SellerStockPayload }
  | { status: "unauthorized" }
  | { status: "error"; message: string };

export type InventoryErrorEnvelope = {
  error?: {
    code?: unknown;
    message?: unknown;
  };
};

function isStockLevel(value: unknown): value is SellerStockPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.productId !== "string" || typeof candidate.version !== "number") {
    return false;
  }
  if (candidate.mode === "tracked") {
    return (
      typeof candidate.onHand === "number" &&
      typeof candidate.reserved === "number" &&
      typeof candidate.available === "number"
    );
  }
  if (candidate.mode === "untracked") {
    return (
      candidate.onHand === null &&
      (candidate.reserved === null || typeof candidate.reserved === "number") &&
      candidate.available === null
    );
  }
  return false;
}

export function extractInventoryApiError(payload: unknown): {
  code: string | null;
  message: string | null;
} {
  if (!payload || typeof payload !== "object") {
    return { code: null, message: null };
  }
  const error = (payload as InventoryErrorEnvelope).error;
  if (!error || typeof error !== "object") {
    return { code: null, message: null };
  }
  return {
    code: typeof error.code === "string" ? error.code : null,
    message: typeof error.message === "string" ? error.message : null,
  };
}

/**
 * Classifies the response of `GET /api/seller/inventory/{productId}`.
 * Only a confirmed 404 `NOT_FOUND` with `"Inventory record was not found."`
 * is treated as an undecided stock policy (`status: "undecided"`).
 * Any other 404 (e.g. missing product or HTML route error) or non-200 response
 * is classified as an explicit load error so the UI never fabricates stock state.
 */
export function classifyInventoryReadResult(
  httpStatus: number,
  payload: unknown,
): StockControlViewState {
  if (httpStatus === 200) {
    if (isStockLevel(payload)) {
      return { status: "ready", stock: payload };
    }
    return {
      status: "error",
      message: "Received an invalid inventory response from the server.",
    };
  }

  if (httpStatus === 401) {
    return { status: "unauthorized" };
  }

  const { code, message } = extractInventoryApiError(payload);
  if (
    httpStatus === 404 &&
    code === "NOT_FOUND" &&
    message === MISSING_INVENTORY_RECORD_MESSAGE
  ) {
    return { status: "undecided" };
  }

  return {
    status: "error",
    message: message ?? `Could not load stock status (HTTP ${httpStatus}).`,
  };
}

export function isInventoryConflictFailure(httpStatus: number, payload: unknown): boolean {
  const { code } = extractInventoryApiError(payload);
  return httpStatus === 409 || code === "CONFLICT";
}

export type PolicyFormValidation =
  | {
      ok: true;
      value:
        | { mode: "tracked"; onHand: number; reason: string }
        | { mode: "untracked"; reason: string };
      signature: string;
    }
  | { ok: false; error: string };

export function validatePolicyFormInput(input: {
  mode: "" | "tracked" | "untracked";
  onHandRaw: string;
  reasonRaw: string;
}): PolicyFormValidation {
  if (input.mode !== "tracked" && input.mode !== "untracked") {
    return {
      ok: false,
      error: "Select whether to track quantity or leave stock untracked.",
    };
  }

  const reason = input.reasonRaw.trim();
  if (reason.length < 3 || reason.length > 500) {
    return {
      ok: false,
      error: "Enter a reason between 3 and 500 characters.",
    };
  }

  if (input.mode === "untracked") {
    return {
      ok: true,
      value: { mode: "untracked", reason },
      signature: `policy:untracked:${reason}`,
    };
  }

  const trimmedQty = input.onHandRaw.trim();
  if (!/^\d+$/.test(trimmedQty)) {
    return {
      ok: false,
      error: "Enter a whole non-negative quantity (0 or more).",
    };
  }
  const onHand = Number(trimmedQty);
  if (!Number.isSafeInteger(onHand) || onHand < 0 || onHand > 1_000_000) {
    return {
      ok: false,
      error: "On-hand quantity must be an integer between 0 and 1,000,000.",
    };
  }

  return {
    ok: true,
    value: { mode: "tracked", onHand, reason },
    signature: `policy:tracked:${onHand}:${reason}`,
  };
}

export type AdjustFormValidation =
  | {
      ok: true;
      value: { delta: number; expectedVersion: number; reason: string };
      signature: string;
    }
  | { ok: false; error: string };

export function validateAdjustFormInput(input: {
  deltaRaw: string;
  reasonRaw: string;
  expectedVersion: number;
}): AdjustFormValidation {
  const trimmedDelta = input.deltaRaw.trim();
  if (!/^[+-]?\d+$/.test(trimmedDelta)) {
    return {
      ok: false,
      error: "Enter a non-zero whole number change (for example +5 or -1).",
    };
  }
  const delta = Number(trimmedDelta);
  if (
    !Number.isSafeInteger(delta) ||
    delta === 0 ||
    delta < -1_000_000 ||
    delta > 1_000_000
  ) {
    return {
      ok: false,
      error: "Quantity change must be a non-zero integer between -1,000,000 and 1,000,000.",
    };
  }

  const reason = input.reasonRaw.trim();
  if (reason.length < 3 || reason.length > 500) {
    return {
      ok: false,
      error: "Enter a reason between 3 and 500 characters.",
    };
  }

  return {
    ok: true,
    value: {
      delta,
      expectedVersion: input.expectedVersion,
      reason,
    },
    signature: `adjust:${input.expectedVersion}:${delta}:${reason}`,
  };
}

export type StableIdempotencyState = {
  signature: string;
  key: string;
} | null;

export function resolveIdempotencyKey(
  previous: StableIdempotencyState,
  signature: string,
  createKey: () => string,
): { nextState: { signature: string; key: string }; key: string } {
  if (previous && previous.signature === signature) {
    return { nextState: previous, key: previous.key };
  }
  const nextState = { signature, key: createKey() };
  return { nextState, key: nextState.key };
}

export function formatSellerProductStockSummary(
  catalogAvailability: "available" | "unavailable",
  stockState: StockControlViewState,
): string {
  if (catalogAvailability === "unavailable") {
    return "Unavailable";
  }
  switch (stockState.status) {
    case "loading":
      return "Checking stock…";
    case "undecided":
      return "Stock decision required";
    case "ready":
      if (stockState.stock.mode === "untracked") {
        return "Available · Untracked stock";
      }
      if ((stockState.stock.available ?? 0) <= 0) {
        return `Out of stock · 0 available (${stockState.stock.onHand ?? 0} on hand, ${stockState.stock.reserved ?? 0} reserved)`;
      }
      return `Available · ${stockState.stock.available} available (${stockState.stock.onHand} on hand, ${stockState.stock.reserved} reserved)`;
    case "unauthorized":
      return "Session expired";
    case "error":
      return "Stock status unavailable";
  }
}
