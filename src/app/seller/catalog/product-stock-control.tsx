"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  type StableIdempotencyState,
  type StockControlViewState,
  classifyInventoryReadResult,
  extractInventoryApiError,
  isInventoryConflictFailure,
  resolveIdempotencyKey,
  validateAdjustFormInput,
  validatePolicyFormInput,
} from "./stock-control-state";

type Props = {
  productId: string;
  onStateChange?: (state: StockControlViewState) => void;
};

function generateIdempotencyKey(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

async function readJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function ProductStockControl({ productId, onStateChange }: Props) {
  const router = useRouter();
  const baseId = useId();
  const [viewState, setViewState] = useState<StockControlViewState>({
    status: "loading",
  });

  // Policy form state (for undecided products)
  const [policyMode, setPolicyMode] = useState<"" | "tracked" | "untracked">("");
  const [policyOnHand, setPolicyOnHand] = useState("0");
  const [policyReason, setPolicyReason] = useState("Initial stock count");
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const policyIdempotencyRef = useRef<StableIdempotencyState>(null);

  // Adjustment form state (for tracked products)
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustDelta, setAdjustDelta] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [adjustBusy, setAdjustBusy] = useState(false);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [adjustNotice, setAdjustNotice] = useState<string | null>(null);
  const adjustIdempotencyRef = useRef<StableIdempotencyState>(null);

  const updateViewState = useCallback(
    (next: StockControlViewState) => {
      setViewState(next);
      onStateChange?.(next);
    },
    [onStateChange],
  );

  const loadStock = useCallback(async (): Promise<StockControlViewState> => {
    try {
      const response = await fetch(
        `/api/seller/inventory/${encodeURIComponent(productId)}`,
        {
          method: "GET",
          cache: "no-store",
        },
      );
      const payload = await readJsonSafe(response);
      const next = classifyInventoryReadResult(response.status, payload);
      if (next.status === "unauthorized") {
        updateViewState(next);
        router.replace("/seller/sign-in");
        return next;
      }
      updateViewState(next);
      return next;
    } catch {
      const next: StockControlViewState = {
        status: "error",
        message: "Network error while checking stock status.",
      };
      updateViewState(next);
      return next;
    }
  }, [productId, router, updateViewState]);

  useEffect(() => {
    let active = true;
    fetch(`/api/seller/inventory/${encodeURIComponent(productId)}`, {
      method: "GET",
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = await readJsonSafe(response);
        if (!active) {
          return;
        }
        const next = classifyInventoryReadResult(response.status, payload);
        updateViewState(next);
        if (next.status === "unauthorized") {
          router.replace("/seller/sign-in");
        }
      })
      .catch(() => {
        if (!active) {
          return;
        }
        updateViewState({
          status: "error",
          message: "Network error while checking stock status.",
        });
      });
    return () => {
      active = false;
    };
  }, [productId, router, updateViewState]);

  async function handleSetPolicy(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (policyBusy) {
      return;
    }
    setPolicyError(null);
    setAdjustNotice(null);

    const validated = validatePolicyFormInput({
      mode: policyMode,
      onHandRaw: policyOnHand,
      reasonRaw: policyReason,
    });
    if (!validated.ok) {
      setPolicyError(validated.error);
      return;
    }

    const { nextState, key } = resolveIdempotencyKey(
      policyIdempotencyRef.current,
      validated.signature,
      () => generateIdempotencyKey("policy"),
    );
    policyIdempotencyRef.current = nextState;

    setPolicyBusy(true);
    try {
      const body =
        validated.value.mode === "tracked"
          ? {
              mode: "tracked" as const,
              onHand: validated.value.onHand,
              reason: validated.value.reason,
              idempotencyKey: key,
            }
          : {
              mode: "untracked" as const,
              reason: validated.value.reason,
              idempotencyKey: key,
            };

      const response = await fetch(
        `/api/seller/inventory/${encodeURIComponent(productId)}/policy`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const payload = await readJsonSafe(response);

      if (response.status === 401) {
        router.replace("/seller/sign-in");
        return;
      }

      if (response.ok) {
        const classified = classifyInventoryReadResult(200, payload);
        if (classified.status === "ready") {
          policyIdempotencyRef.current = null;
          updateViewState(classified);
          setAdjustNotice("Stock policy saved.");
          return;
        }
      }

      if (isInventoryConflictFailure(response.status, payload)) {
        policyIdempotencyRef.current = null;
        const refreshed = await loadStock();
        if (refreshed.status === "ready") {
          setAdjustNotice(
            "Stock policy was already configured in another session; showing the current server state.",
          );
          return;
        }
      }

      const apiError = extractInventoryApiError(payload);
      setPolicyError(
        apiError.message ?? "Could not save stock policy. Try again.",
      );
    } catch {
      setPolicyError("Network error while saving stock policy. Try again.");
    } finally {
      setPolicyBusy(false);
    }
  }

  async function handleAdjustStock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (adjustBusy || viewState.status !== "ready" || viewState.stock.mode !== "tracked") {
      return;
    }
    setAdjustError(null);
    setAdjustNotice(null);

    const validated = validateAdjustFormInput({
      deltaRaw: adjustDelta,
      reasonRaw: adjustReason,
      expectedVersion: viewState.stock.version,
    });
    if (!validated.ok) {
      setAdjustError(validated.error);
      return;
    }

    const { nextState, key } = resolveIdempotencyKey(
      adjustIdempotencyRef.current,
      validated.signature,
      () => generateIdempotencyKey("adjust"),
    );
    adjustIdempotencyRef.current = nextState;

    setAdjustBusy(true);
    try {
      const response = await fetch(
        `/api/seller/inventory/${encodeURIComponent(productId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            delta: validated.value.delta,
            expectedVersion: validated.value.expectedVersion,
            reason: validated.value.reason,
            idempotencyKey: key,
          }),
        },
      );
      const payload = await readJsonSafe(response);

      if (response.status === 401) {
        router.replace("/seller/sign-in");
        return;
      }

      if (response.ok) {
        const classified = classifyInventoryReadResult(200, payload);
        if (classified.status === "ready") {
          adjustIdempotencyRef.current = null;
          updateViewState(classified);
          setAdjustDelta("");
          setAdjustReason("");
          setAdjustOpen(false);
          const signedDelta =
            validated.value.delta > 0
              ? `+${validated.value.delta}`
              : `${validated.value.delta}`;
          setAdjustNotice(
            `Quantity adjusted (${signedDelta}). Available stock is now ${classified.stock.available ?? 0}.`,
          );
          return;
        }
      }

      if (isInventoryConflictFailure(response.status, payload)) {
        adjustIdempotencyRef.current = null;
        const refreshed = await loadStock();
        const signedDelta =
          validated.value.delta > 0
            ? `+${validated.value.delta}`
            : `${validated.value.delta}`;
        if (refreshed.status === "ready" && refreshed.stock.mode === "tracked") {
          setAdjustError(
            `Stock changed while you were editing (now ${refreshed.stock.onHand} on hand, ${refreshed.stock.reserved} reserved, ${refreshed.stock.available} available, version ${refreshed.stock.version}). Review the updated numbers and submit again to confirm your ${signedDelta} adjustment.`,
          );
        } else {
          const apiError = extractInventoryApiError(payload);
          setAdjustError(
            apiError.message ??
              "Stock changed before your adjustment could be applied. Review the latest state and try again.",
          );
        }
        return;
      }

      const apiError = extractInventoryApiError(payload);
      setAdjustError(
        apiError.message ?? "Could not adjust stock quantity. Try again.",
      );
    } catch {
      setAdjustError("Network error while adjusting stock quantity. Try again.");
    } finally {
      setAdjustBusy(false);
    }
  }

  if (viewState.status === "loading") {
    return (
      <div
        className="mt-3 border-t border-zinc-200 pt-3 text-xs text-zinc-600"
        data-testid={`stock-control-${productId}`}
      >
        Checking stock policy…
      </div>
    );
  }

  if (viewState.status === "unauthorized") {
    return null;
  }

  if (viewState.status === "error") {
    return (
      <div
        className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 pt-3"
        data-testid={`stock-control-${productId}`}
      >
        <p role="alert" className="text-xs font-medium text-red-700">
          {viewState.message}
        </p>
        <button
          type="button"
          onClick={() => {
            updateViewState({ status: "loading" });
            void loadStock();
          }}
          className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
        >
          Retry stock check
        </button>
      </div>
    );
  }

  if (viewState.status === "undecided") {
    return (
      <div
        className="mt-3 border-t border-zinc-200 pt-3"
        data-testid={`stock-control-${productId}`}
      >
        <div className="rounded-md border border-amber-300 bg-amber-50/60 p-3">
          <p className="text-xs font-semibold text-zinc-900">
            Stock decision required
          </p>
          <p className="mt-0.5 text-xs text-zinc-700">
            Buyers cannot check out this physical product until you choose whether to track quantity or leave stock untracked.
          </p>

          <form onSubmit={handleSetPolicy} className="mt-3 grid gap-3">
            <fieldset className="grid gap-2 sm:grid-cols-2">
              <legend className="sr-only">Stock policy mode</legend>
              <label
                htmlFor={`${baseId}-mode-tracked`}
                className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-xs ${
                  policyMode === "tracked"
                    ? "border-zinc-900 bg-white font-medium text-zinc-950"
                    : "border-zinc-300 bg-white text-zinc-800"
                }`}
              >
                <input
                  id={`${baseId}-mode-tracked`}
                  type="radio"
                  name={`${baseId}-policy-mode`}
                  value="tracked"
                  checked={policyMode === "tracked"}
                  onChange={() => {
                    setPolicyMode("tracked");
                    setPolicyError(null);
                  }}
                  className="mt-0.5"
                />
                <span>
                  <span className="block font-medium text-zinc-900">
                    Track quantity
                  </span>
                  <span className="mt-0.5 block text-zinc-600">
                    Set on-hand units; checkout reserves stock.
                  </span>
                </span>
              </label>

              <label
                htmlFor={`${baseId}-mode-untracked`}
                className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-xs ${
                  policyMode === "untracked"
                    ? "border-zinc-900 bg-white font-medium text-zinc-950"
                    : "border-zinc-300 bg-white text-zinc-800"
                }`}
              >
                <input
                  id={`${baseId}-mode-untracked`}
                  type="radio"
                  name={`${baseId}-policy-mode`}
                  value="untracked"
                  checked={policyMode === "untracked"}
                  onChange={() => {
                    setPolicyMode("untracked");
                    setPolicyError(null);
                  }}
                  className="mt-0.5"
                />
                <span>
                  <span className="block font-medium text-zinc-900">
                    Do not track quantity
                  </span>
                  <span className="mt-0.5 block text-zinc-600">
                    Always purchasable without unit limits.
                  </span>
                </span>
              </label>
            </fieldset>

            {policyMode === "tracked" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor={`${baseId}-policy-onhand`}
                    className="block text-xs font-medium text-zinc-800"
                  >
                    Initial on-hand quantity
                  </label>
                  <input
                    id={`${baseId}-policy-onhand`}
                    type="number"
                    min={0}
                    max={1000000}
                    step={1}
                    inputMode="numeric"
                    required
                    value={policyOnHand}
                    onChange={(event) => {
                      setPolicyOnHand(event.target.value);
                      setPolicyError(null);
                    }}
                    className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-950 tabular-nums"
                  />
                </div>
                <div>
                  <label
                    htmlFor={`${baseId}-policy-reason`}
                    className="block text-xs font-medium text-zinc-800"
                  >
                    Reason
                  </label>
                  <input
                    id={`${baseId}-policy-reason`}
                    type="text"
                    required
                    maxLength={500}
                    value={policyReason}
                    onChange={(event) => {
                      setPolicyReason(event.target.value);
                      setPolicyError(null);
                    }}
                    className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-950"
                  />
                </div>
              </div>
            )}

            {policyMode === "untracked" && (
              <div>
                <label
                  htmlFor={`${baseId}-policy-reason`}
                  className="block text-xs font-medium text-zinc-800"
                >
                  Reason
                </label>
                <input
                  id={`${baseId}-policy-reason`}
                  type="text"
                  required
                  maxLength={500}
                  value={policyReason}
                  onChange={(event) => {
                    setPolicyReason(event.target.value);
                    setPolicyError(null);
                  }}
                  className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-950"
                />
              </div>
            )}

            {policyError && (
              <p role="alert" className="text-xs font-medium text-red-700">
                {policyError}
              </p>
            )}

            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={policyBusy}
                className="rounded-md bg-zinc-950 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
              >
                {policyBusy ? "Saving policy…" : "Save stock policy"}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  const { stock } = viewState;

  if (stock.mode === "untracked") {
    return (
      <div
        className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 pt-3 text-xs text-zinc-600"
        data-testid={`stock-control-${productId}`}
      >
        <span>
          Stock policy: <strong className="font-medium text-zinc-900">Untracked</strong> (no quantity limit)
        </span>
        {adjustNotice && (
          <span role="status" className="font-medium text-emerald-800">
            {adjustNotice}
          </span>
        )}
      </div>
    );
  }

  const isZeroAvailable = (stock.available ?? 0) <= 0;

  return (
    <div
      className="mt-3 border-t border-zinc-200 pt-3"
      data-testid={`stock-control-${productId}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums">
          <div className="flex items-center gap-1">
            <dt className="text-zinc-500">Stock:</dt>
            <dd className="font-medium text-zinc-900">Tracked</dd>
          </div>
          <div className="flex items-center gap-1">
            <dt className="text-zinc-500">On hand:</dt>
            <dd className="font-semibold text-zinc-900" data-testid={`stock-onhand-${productId}`}>
              {stock.onHand}
            </dd>
          </div>
          <div className="flex items-center gap-1">
            <dt className="text-zinc-500">Reserved:</dt>
            <dd className="font-medium text-zinc-800" data-testid={`stock-reserved-${productId}`}>
              {stock.reserved}
            </dd>
          </div>
          <div className="flex items-center gap-1">
            <dt className="text-zinc-500">Available:</dt>
            <dd
              className={
                isZeroAvailable
                  ? "font-semibold text-amber-800"
                  : "font-semibold text-zinc-900"
              }
              data-testid={`stock-available-${productId}`}
            >
              {stock.available}
              {isZeroAvailable ? " (out of stock for checkout)" : ""}
            </dd>
          </div>
          <div className="flex items-center gap-1">
            <dt className="text-zinc-400">Version:</dt>
            <dd className="text-zinc-500" data-testid={`stock-version-${productId}`}>
              {stock.version}
            </dd>
          </div>
        </dl>

        <button
          type="button"
          onClick={() => {
            setAdjustOpen((current) => !current);
            setAdjustError(null);
            setAdjustNotice(null);
          }}
          className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
        >
          {adjustOpen ? "Close adjustment" : "Adjust quantity"}
        </button>
      </div>

      {adjustNotice && (
        <p role="status" className="mt-2 text-xs font-medium text-emerald-800">
          {adjustNotice}
        </p>
      )}

      {adjustOpen && (
        <form
          onSubmit={handleAdjustStock}
          className="mt-3 grid gap-3 rounded-md border border-zinc-200 bg-zinc-50/70 p-3"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor={`${baseId}-adjust-delta`}
                className="block text-xs font-medium text-zinc-800"
              >
                Quantity change (+ to add, - to remove)
              </label>
              <input
                id={`${baseId}-adjust-delta`}
                type="number"
                step={1}
                inputMode="numeric"
                required
                placeholder="+5 or -1"
                value={adjustDelta}
                onChange={(event) => {
                  setAdjustDelta(event.target.value);
                  setAdjustError(null);
                }}
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-950 tabular-nums"
              />
            </div>

            <div>
              <label
                htmlFor={`${baseId}-adjust-reason`}
                className="block text-xs font-medium text-zinc-800"
              >
                Reason
              </label>
              <input
                id={`${baseId}-adjust-reason`}
                type="text"
                required
                maxLength={500}
                placeholder="Restock, recount, damaged item…"
                value={adjustReason}
                onChange={(event) => {
                  setAdjustReason(event.target.value);
                  setAdjustError(null);
                }}
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-950"
              />
            </div>
          </div>

          {adjustError && (
            <p role="alert" className="text-xs font-medium text-red-700">
              {adjustError}
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={adjustBusy}
              className="rounded-md bg-zinc-950 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
            >
              {adjustBusy ? "Applying…" : "Apply adjustment"}
            </button>
            <button
              type="button"
              disabled={adjustBusy}
              onClick={() => {
                setAdjustOpen(false);
                setAdjustError(null);
              }}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
