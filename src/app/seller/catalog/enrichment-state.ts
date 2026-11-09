import {
  type AmbiguousCandidate,
  type CatalogEnrichmentSuggestion,
  type ReferencePriceComparison,
  catalogEnrichmentResult,
} from "@/server/contracts/catalog-enrichment";

export type ProductEnrichmentViewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "not_configured" }
  | { status: "no_match" }
  | {
      status: "ambiguous";
      candidates: AmbiguousCandidate[];
      message?: string;
    }
  | {
      status: "exact_match";
      suggestion: CatalogEnrichmentSuggestion;
    }
  | { status: "rate_limited"; message?: string }
  | { status: "provider_error"; message: string }
  | {
      status: "applied";
      appliedPrice: string;
      suggestion?: CatalogEnrichmentSuggestion;
    };

export const ENRICHMENT_MESSAGES = {
  CHECK_BUTTON: "Check market specs & price",
  CHECKING_STATUS: "Checking Channel3 product data...",
  NOT_CONFIGURED: "Channel3 enrichment is not configured in this environment.",
  NO_MATCH: "No reference product match found on Channel3.",
  AMBIGUOUS_TITLE: "Multiple product variants match this title. Please review:",
  RATE_LIMITED: "Channel3 rate limit exceeded. Please try again later.",
  PROVIDER_ERROR_PREFIX: "Channel3 data unavailable",
  APPLIED_CONFIRMATION: "Reference price applied. Don't forget to save changes.",
  DIFFERENT_CURRENCY: (offerCurrency: string, shopCurrency: string) =>
    `Different currency (${offerCurrency.toUpperCase()} vs ${shopCurrency.toUpperCase()}) — cannot directly compare prices`,
} as const;

/**
 * Checks if a reference offer price has a currency comparable to the shop's currency.
 */
export function isComparableCurrency(
  offerCurrency: string,
  shopCurrency: string,
  isComparableFlag?: boolean,
): boolean {
  if (isComparableFlag === false) {
    return false;
  }
  return offerCurrency.trim().toUpperCase() === shopCurrency.trim().toUpperCase();
}

/**
 * Finds the first comparable price recommendation from a list of reference prices.
 */
export function findComparableReferencePrice(
  prices: ReferencePriceComparison[],
  shopCurrency: string,
): ReferencePriceComparison | null {
  for (const price of prices) {
    if (isComparableCurrency(price.currency, shopCurrency, price.isComparableCurrency)) {
      return price;
    }
  }
  return null;
}

/**
 * Formats a decimal amount and currency code for user display (e.g. €24.99 or $49.00).
 */
export function formatPriceWithCurrency(amount: string, currency: string): string {
  const num = Number(amount);
  if (!Number.isNaN(num) && Number.isFinite(num)) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency.toUpperCase(),
      }).format(num);
    } catch {
      // Fallback if the currency code is unrecognized
    }
  }
  return `${amount} ${currency.toUpperCase()}`;
}

/**
 * Formats an ISO datetime string into a clean, human-readable date.
 */
export function formatRetrievedDate(isoDate: string): string {
  try {
    const date = new Date(isoDate);
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
      }).format(date);
    }
  } catch {
    // Fallback
  }
  return isoDate;
}

/**
 * Classifies the HTTP status and JSON response body from GET /api/seller/catalog/[id]/enrichment.
 */
export function classifyEnrichmentApiResponse(
  httpStatus: number,
  payload: unknown,
): ProductEnrichmentViewState {
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      status: "provider_error",
      message: `${ENRICHMENT_MESSAGES.PROVIDER_ERROR_PREFIX}: authentication failed.`,
    };
  }

  if (httpStatus === 429) {
    const errorMsg =
      payload &&
      typeof payload === "object" &&
      "message" in payload &&
      typeof payload.message === "string"
        ? payload.message
        : ENRICHMENT_MESSAGES.RATE_LIMITED;
    return {
      status: "rate_limited",
      message: errorMsg,
    };
  }

  if (httpStatus >= 500) {
    return {
      status: "provider_error",
      message: `${ENRICHMENT_MESSAGES.PROVIDER_ERROR_PREFIX}: server error (HTTP ${httpStatus}).`,
    };
  }

  if (httpStatus === 200) {
    const parsed = catalogEnrichmentResult.safeParse(payload);
    if (!parsed.success) {
      return {
        status: "provider_error",
        message: `${ENRICHMENT_MESSAGES.PROVIDER_ERROR_PREFIX}: invalid response structure.`,
      };
    }

    const data = parsed.data;
    switch (data.status) {
      case "exact_match":
        if (data.suggestion) {
          return {
            status: "exact_match",
            suggestion: data.suggestion,
          };
        }
        return {
          status: "provider_error",
          message: `${ENRICHMENT_MESSAGES.PROVIDER_ERROR_PREFIX}: exact match missing suggestion data.`,
        };
      case "ambiguous":
        return {
          status: "ambiguous",
          candidates: data.ambiguousCandidates ?? [],
          message: data.message ?? ENRICHMENT_MESSAGES.AMBIGUOUS_TITLE,
        };
      case "no_match":
        return { status: "no_match" };
      case "not_configured":
        return { status: "not_configured" };
      case "rate_limited":
        return {
          status: "rate_limited",
          message: data.message ?? ENRICHMENT_MESSAGES.RATE_LIMITED,
        };
      case "provider_error":
        return {
          status: "provider_error",
          message: data.message
            ? `${ENRICHMENT_MESSAGES.PROVIDER_ERROR_PREFIX}: ${data.message}`
            : `${ENRICHMENT_MESSAGES.PROVIDER_ERROR_PREFIX}.`,
        };
    }
  }

  return {
    status: "provider_error",
    message: `${ENRICHMENT_MESSAGES.PROVIDER_ERROR_PREFIX} (HTTP ${httpStatus}).`,
  };
}
