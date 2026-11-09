import { z } from "zod";

// Match and provider status for Channel3 accessory enrichment
export const ENRICHMENT_STATUSES = [
  "exact_match",
  "ambiguous",
  "no_match",
  "not_configured",
  "rate_limited",
  "provider_error",
] as const;

export type EnrichmentMatchStatus = (typeof ENRICHMENT_STATUSES)[number];

// Structured factual attribute suggested by Channel3
export const enrichmentAttribute = z.strictObject({
  name: z.string().min(1).max(100),
  value: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1).optional(),
});

export type EnrichmentAttribute = z.infer<typeof enrichmentAttribute>;

// Reference price point from an external retailer/domain
export const referencePriceComparison = z.strictObject({
  domain: z.string().min(1).max(255),
  amount: z.string().min(1).max(60),
  currency: z.string().min(1).max(10),
  isComparableCurrency: z.boolean(),
  url: z.string().url().max(1000),
  retrievedAt: z.string().datetime(),
});

export type ReferencePriceComparison = z.infer<typeof referencePriceComparison>;

// Ambiguous candidate alternative shown to the seller without automatic application
export const ambiguousCandidate = z.strictObject({
  title: z.string().min(1).max(300),
  domain: z.string().max(255).optional(),
  variantInfo: z.string().max(200).optional(),
});

export type AmbiguousCandidate = z.infer<typeof ambiguousCandidate>;

// Structured suggestion reviewed by seller
export const catalogEnrichmentSuggestion = z.strictObject({
  canonicalTitle: z.string().min(1).max(300),
  description: z.string().max(2000),
  attributes: z.array(enrichmentAttribute),
  referencePrices: z.array(referencePriceComparison),
  sourceDomain: z.string().max(255).optional(),
  sourceUrl: z.string().url().max(1000).optional(),
  retrievedAt: z.string().datetime(),
});

export type CatalogEnrichmentSuggestion = z.infer<typeof catalogEnrichmentSuggestion>;

// Full enrichment result returned by GET/POST /api/seller/catalog/[id]/enrichment
export const catalogEnrichmentResult = z.strictObject({
  productId: z.string().uuid(),
  productTitle: z.string().min(1).max(300),
  status: z.enum(ENRICHMENT_STATUSES),
  message: z.string().max(500).optional(),
  suggestion: catalogEnrichmentSuggestion.optional(),
  ambiguousCandidates: z.array(ambiguousCandidate).optional(),
});

export type CatalogEnrichmentResult = z.infer<typeof catalogEnrichmentResult>;

// Request body for triggering enrichment (optional search query override)
export const catalogEnrichmentRequest = z.strictObject({
  query: z.string().min(1).max(200).optional(),
});

export type CatalogEnrichmentRequest = z.infer<typeof catalogEnrichmentRequest>;
