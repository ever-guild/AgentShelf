import {
  catalogEnrichmentResult,
  type CatalogEnrichmentResult,
} from "../contracts/catalog-enrichment";
import { z } from "zod";
import { matchChannel3Results } from "./matching";
import type { Channel3EnrichmentOptions } from "./types";

const DEFAULT_CHANNEL3_ENDPOINT = "https://api.trychannel3.com/v1/search";
const TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

const channel3SearchResponseSchema = z.object({
  products: z.array(z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().nullable().optional(),
    brands: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
    structured_attributes: z.record(z.string(), z.array(z.string())).optional(),
    variants: z.object({
      options: z.array(z.object({ name: z.string(), values: z.array(z.object({ label: z.string() })) })),
      selected: z.array(z.object({ name: z.string(), label: z.string() })),
    }).nullable().optional(),
    offers: z.array(z.object({
      domain: z.string(),
      price: z.object({ price: z.number().finite(), currency: z.string() }),
      availability: z.enum(["InStock", "OutOfStock"]),
      url: z.string().url(),
    })).optional(),
  })),
  next_page_token: z.string().nullable().optional(),
});

async function readJsonWithin(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("Channel3 response exceeded size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

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

    const raw = await readJsonWithin(response, MAX_RESPONSE_BYTES);
    const parsed = channel3SearchResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return catalogEnrichmentResult.parse({
        productId,
        productTitle,
        status: "provider_error",
        message: "Channel3 returned an invalid response",
      });
    }
    const products = parsed.data.products;

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
