import {
  catalogEnrichmentResult,
  type CatalogEnrichmentResult,
} from "../contracts/catalog-enrichment";
import { matchChannel3Results } from "./matching";
import type { Channel3EnrichmentOptions, Channel3SearchResponse } from "./types";

const DEFAULT_CHANNEL3_ENDPOINT = "https://api.trychannel3.com/v1/search";
const TIMEOUT_MS = 5000;

function createTimeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("Timeout")), ms);
  return controller.signal;
}

export async function enrichCatalogProduct(
  options: Channel3EnrichmentOptions,
): Promise<CatalogEnrichmentResult> {
  const { productId, productTitle, shopCurrency } = options;
  const apiKey = (options.apiKey ?? process.env.CHANNEL3_API_KEY)?.trim();

  // If CHANNEL3_API_KEY is not set: status not_configured, safe message, do not throw
  if (!apiKey) {
    return catalogEnrichmentResult.parse({
      productId,
      productTitle,
      status: "not_configured",
      message: "Channel3 API key not configured",
    });
  }

  const endpoint = options.endpoint ?? process.env.CHANNEL3_SEARCH_ENDPOINT ?? DEFAULT_CHANNEL3_ENDPOINT;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const searchQuery = (options.query && options.query.trim().length > 0) ? options.query.trim() : productTitle;

  try {
    const signal = createTimeoutSignal(TIMEOUT_MS);
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: searchQuery,
        limit: 5,
      }),
      signal,
    });

    if (response.status === 429) {
      return catalogEnrichmentResult.parse({
        productId,
        productTitle,
        status: "rate_limited",
        message: "Channel3 rate limit exceeded. Please try again later.",
      });
    }

    if (response.status === 401 || response.status === 403) {
      return catalogEnrichmentResult.parse({
        productId,
        productTitle,
        status: "provider_error",
        message: "Channel3 authentication failed",
      });
    }

    if (!response.ok) {
      return catalogEnrichmentResult.parse({
        productId,
        productTitle,
        status: "provider_error",
        message: "Channel3 provider unavailable",
      });
    }

    const data = (await response.json()) as Channel3SearchResponse;
    const products = Array.isArray(data?.products) ? data.products : [];

    return matchChannel3Results({
      productId,
      productTitle,
      products,
      shopCurrency,
    });
  } catch {
    // Network errors, timeouts, or JSON parsing issues
    return catalogEnrichmentResult.parse({
      productId,
      productTitle,
      status: "provider_error",
      message: "Channel3 provider unavailable",
    });
  }
}
