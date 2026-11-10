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
  price: number;
  currency: string;
}

export interface Channel3Offer {
  domain?: string;
  price?: Channel3OfferPrice;
  availability?: string;
  url?: string;
}

export interface Channel3Product {
  id: string;
  title: string;
  description?: string | null;
  brands?: Array<{ id: string; name: string }>;
  images?: Array<{ url: string; cleaned_url?: string | null; alt_text?: string | null }>;
  structured_attributes?: Record<string, string[]>;
  variants?: { options: Array<{ name: string; values: Array<{ label: string }> }>; selected: Array<{ name: string; label: string }> } | null;
  offers?: Channel3Offer[];
}

export interface Channel3SearchResponse {
  products?: Channel3Product[];
  next_page_token?: string | null;
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
