import type {
  AmbiguousCandidate,
  CatalogEnrichmentResult,
  CatalogEnrichmentSuggestion,
  EnrichmentAttribute,
  EnrichmentMatchStatus,
  ReferencePriceComparison,
} from "../contracts/catalog-enrichment";

export type {
  AmbiguousCandidate,
  CatalogEnrichmentResult,
  CatalogEnrichmentSuggestion,
  EnrichmentAttribute,
  EnrichmentMatchStatus,
  ReferencePriceComparison,
};

export interface Channel3SearchRequestBody {
  query: string;
  limit?: number;
}

export interface Channel3OfferPrice {
  amount: number | string;
  currency: string;
}

export interface Channel3Offer {
  domain?: string;
  price?: Channel3OfferPrice;
  availability?: string;
  url?: string;
}

export interface Channel3Product {
  id?: string;
  title: string;
  description?: string;
  brand?: string;
  model?: string;
  images?: string[];
  attributes?: Record<string, string> | Array<{ name: string; value: string; confidence?: number }>;
  offers?: Channel3Offer[];
}

export interface Channel3SearchResponse {
  products?: Channel3Product[];
  error?: string;
  message?: string;
}

export interface Channel3EnrichmentOptions {
  productId: string;
  productTitle: string;
  query?: string;
  shopCurrency: string;
  apiKey?: string;
  endpoint?: string;
  fetch?: typeof fetch;
}

export interface MatchChannel3Options {
  productId: string;
  productTitle: string;
  products: Channel3Product[];
  shopCurrency: string;
  retrievedAt?: string;
}
