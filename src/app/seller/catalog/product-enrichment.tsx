"use client";

import { useCallback, useState } from "react";

import {
  ENRICHMENT_MESSAGES,
  type ProductEnrichmentViewState,
  classifyEnrichmentApiResponse,
  formatPriceWithCurrency,
  formatRetrievedDate,
  isComparableCurrency,
} from "./enrichment-state";

export type ProductEnrichmentProps = {
  productId: string;
  productTitle: string;
  shopCurrency: string;
  onApplyPrice: (price: string) => Promise<void> | void;
  initialState?: ProductEnrichmentViewState;
};

const quietButton =
  "inline-flex h-9 items-center rounded-lg border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-900 transition-[background-color,transform] hover:bg-zinc-100 active:scale-[0.98] disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800";

export function ProductEnrichment({
  productId,
  productTitle,
  shopCurrency,
  onApplyPrice,
  initialState,
}: ProductEnrichmentProps) {
  const [viewState, setViewState] = useState<ProductEnrichmentViewState>(
    initialState ?? { status: "idle" },
  );
  const [applying, setApplying] = useState(false);

  const loadEnrichment = useCallback(async () => {
    setViewState({ status: "loading" });
    try {
      const response = await fetch(
        `/api/seller/catalog/${encodeURIComponent(productId)}/enrichment`,
        {
          method: "GET",
          cache: "no-store",
          headers: { Accept: "application/json" },
        },
      );
      const json = await response.json().catch(() => null);
      const next = classifyEnrichmentApiResponse(response.status, json);
      setViewState(next);
    } catch {
      setViewState({
        status: "provider_error",
        message: `${ENRICHMENT_MESSAGES.PROVIDER_ERROR_PREFIX}: network error while fetching enrichment data.`,
      });
    }
  }, [productId]);

  const handleDismiss = useCallback(() => {
    setViewState({ status: "idle" });
  }, []);

  const handleApplyPrice = useCallback(
    async (price: string) => {
      setApplying(true);
      try {
        await onApplyPrice(price);
        setViewState((prev) => ({
          status: "applied",
          appliedPrice: price,
          suggestion: prev.status === "exact_match" ? prev.suggestion : undefined,
        }));
      } catch {
        // Parent onSave handles its own error display
      } finally {
        setApplying(false);
      }
    },
    [onApplyPrice],
  );

  if (viewState.status === "idle") {
    return (
      <div className="mt-2" data-testid={`enrichment-${productId}`}>
        <button
          type="button"
          onClick={loadEnrichment}
          aria-label={`Check market specs & price: ${productTitle}`}
          className={quietButton}
        >
          {ENRICHMENT_MESSAGES.CHECK_BUTTON}
        </button>
      </div>
    );
  }

  if (viewState.status === "loading") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mt-2 flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400"
        data-testid={`enrichment-loading-${productId}`}
      >
        <span
          className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-400 border-t-transparent dark:border-zinc-500"
          aria-hidden="true"
        />
        <span>{ENRICHMENT_MESSAGES.CHECKING_STATUS}</span>
      </div>
    );
  }

  if (viewState.status === "not_configured") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mt-2 flex items-center justify-between rounded-md border border-zinc-200 bg-zinc-50/70 p-2.5 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400"
        data-testid={`enrichment-not-configured-${productId}`}
      >
        <span>{ENRICHMENT_MESSAGES.NOT_CONFIGURED}</span>
        <button
          type="button"
          onClick={handleDismiss}
          className="ml-2 text-xs font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Dismiss
        </button>
      </div>
    );
  }

  if (viewState.status === "no_match") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mt-2 flex items-center justify-between rounded-md border border-zinc-200 bg-zinc-50/70 p-2.5 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400"
        data-testid={`enrichment-no-match-${productId}`}
      >
        <span>{ENRICHMENT_MESSAGES.NO_MATCH}</span>
        <button
          type="button"
          onClick={handleDismiss}
          className="ml-2 text-xs font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Dismiss
        </button>
      </div>
    );
  }

  if (viewState.status === "ambiguous") {
    return (
      <div
        role="region"
        aria-label={`Multiple product matches for ${productTitle}`}
        className="mt-2 rounded-md border border-amber-300/80 bg-amber-50/60 p-3 text-xs dark:border-amber-900/60 dark:bg-amber-950/20"
        data-testid={`enrichment-ambiguous-${productId}`}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-semibold text-zinc-900 dark:text-zinc-100">
              {ENRICHMENT_MESSAGES.AMBIGUOUS_TITLE}
            </p>
            <p className="mt-0.5 text-zinc-600 dark:text-zinc-400">
              No changes were applied. Review the candidate matches or refine your product title.
            </p>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            className="text-xs font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            Dismiss
          </button>
        </div>

        {viewState.candidates.length > 0 ? (
          <ul className="mt-2.5 space-y-1.5 border-t border-amber-200/70 pt-2 dark:border-amber-900/40">
            {viewState.candidates.map((cand, idx) => (
              <li key={idx} className="flex flex-col text-xs text-zinc-800 dark:text-zinc-300">
                <span className="font-medium text-zinc-900 dark:text-zinc-100">{cand.title}</span>
                {(cand.domain || cand.variantInfo) && (
                  <span className="text-zinc-500 dark:text-zinc-400">
                    {[
                      cand.domain && `Source: ${cand.domain}`,
                      cand.variantInfo && `Variant: ${cand.variantInfo}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  if (viewState.status === "exact_match") {
    const { suggestion } = viewState;
    return (
      <div
        role="region"
        aria-label={`Market specs and price for ${productTitle}`}
        className="mt-2 rounded-md border border-zinc-200 bg-zinc-50/80 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900/40"
        data-testid={`enrichment-exact-${productId}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Channel3 Reference Data
            </span>
            <p className="mt-0.5 text-sm font-semibold text-zinc-900 break-words dark:text-zinc-100">
              {suggestion.canonicalTitle}
            </p>
            {suggestion.description ? (
              <p className="mt-1 text-xs text-zinc-600 line-clamp-2 dark:text-zinc-400">
                {suggestion.description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            className="text-xs font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            Dismiss
          </button>
        </div>

        {/* Technical Attributes */}
        {suggestion.attributes && suggestion.attributes.length > 0 ? (
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-zinc-200 pt-2 text-xs sm:grid-cols-3 dark:border-zinc-800">
            {suggestion.attributes.map((attr) => (
              <div key={attr.name} className="min-w-0">
                <dt className="text-zinc-500 dark:text-zinc-400">{attr.name}</dt>
                <dd
                  className="truncate font-medium text-zinc-900 dark:text-zinc-200"
                  title={attr.value}
                >
                  {attr.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {/* Reference Retailer Prices */}
        {suggestion.referencePrices && suggestion.referencePrices.length > 0 ? (
          <div className="mt-3 border-t border-zinc-200 pt-2 dark:border-zinc-800">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Market Reference Prices
            </span>
            <ul className="mt-1.5 space-y-2">
              {suggestion.referencePrices.map((refPrice, idx) => {
                const comparable = isComparableCurrency(
                  refPrice.currency,
                  shopCurrency,
                  refPrice.isComparableCurrency,
                );
                return (
                  <li
                    key={idx}
                    className="flex flex-col gap-1.5 rounded border border-zinc-200/70 bg-white p-2.5 sm:flex-row sm:items-center sm:justify-between dark:border-zinc-800 dark:bg-zinc-950"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-zinc-900 dark:text-zinc-100">
                          {refPrice.domain}
                        </span>
                        <span className="font-semibold tabular-nums text-zinc-700 dark:text-zinc-300">
                          {formatPriceWithCurrency(refPrice.amount, refPrice.currency)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                        <span>Fetched {formatRetrievedDate(refPrice.retrievedAt)}</span>
                        {refPrice.url ? (
                          <>
                            <span>·</span>
                            <a
                              href={refPrice.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline hover:text-zinc-800 dark:hover:text-zinc-200"
                            >
                              Source link
                            </a>
                          </>
                        ) : null}
                      </div>
                      {!comparable ? (
                        <p className="mt-1 text-xs text-doubt">
                          {ENRICHMENT_MESSAGES.DIFFERENT_CURRENCY(refPrice.currency, shopCurrency)}
                        </p>
                      ) : null}
                    </div>

                    {comparable ? (
                      <div className="mt-2 sm:mt-0 sm:shrink-0">
                        <button
                          type="button"
                          disabled={applying}
                          onClick={() => handleApplyPrice(refPrice.amount)}
                          className={quietButton}
                        >
                          {`Apply reference price (${formatPriceWithCurrency(refPrice.amount, refPrice.currency)})`}
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    );
  }

  if (viewState.status === "rate_limited") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mt-2 flex items-center justify-between rounded-md border border-amber-300/80 bg-amber-50/60 p-2.5 text-xs text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200"
        data-testid={`enrichment-rate-limited-${productId}`}
      >
        <span>{viewState.message || ENRICHMENT_MESSAGES.RATE_LIMITED}</span>
        <button
          type="button"
          onClick={handleDismiss}
          className="ml-2 text-xs font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Dismiss
        </button>
      </div>
    );
  }

  if (viewState.status === "provider_error") {
    return (
      <div
        role="alert"
        className="mt-2 flex items-center justify-between rounded-md border border-red-300/80 bg-red-50/60 p-2.5 text-xs text-blocked dark:border-red-900/60 dark:bg-red-950/20"
        data-testid={`enrichment-error-${productId}`}
      >
        <span>{viewState.message}</span>
        <button
          type="button"
          onClick={handleDismiss}
          className="ml-2 text-xs font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Dismiss
        </button>
      </div>
    );
  }

  if (viewState.status === "applied") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mt-2 flex items-center justify-between rounded-md border border-emerald-300/80 bg-emerald-50/60 p-2.5 text-xs text-accepted dark:border-emerald-900/60 dark:bg-emerald-950/20"
        data-testid={`enrichment-applied-${productId}`}
      >
        <div className="flex items-center gap-2">
          <span>{ENRICHMENT_MESSAGES.APPLIED_CONFIRMATION}</span>
          <span className="font-semibold tabular-nums text-zinc-700 dark:text-zinc-300">
            ({formatPriceWithCurrency(viewState.appliedPrice, shopCurrency)})
          </span>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="ml-2 text-xs font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Dismiss
        </button>
      </div>
    );
  }

  return null;
}
