import {
  catalogEnrichmentResult,
  type AmbiguousCandidate,
  type CatalogEnrichmentResult,
  type CatalogEnrichmentSuggestion,
  type EnrichmentAttribute,
  type ReferencePriceComparison,
} from "../contracts/catalog-enrichment";
import type { Channel3Offer, Channel3Product, MatchChannel3Options } from "./types";

export interface ProductSpecs {
  brand?: string;
  family?: string;
  generation?: string;
  tier?: string;
  category?: string;
  variant?: string;
  compatibility?: string;
}

export function isValidUrl(s?: string): boolean {
  if (!s || typeof s !== "string") return false;
  try {
    const url = new URL(s.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function getDomain(offer: Channel3Offer): string {
  if (offer.domain && offer.domain.trim().length > 0) {
    return offer.domain.trim();
  }
  if (offer.url && isValidUrl(offer.url)) {
    try {
      return new URL(offer.url).hostname;
    } catch {
      return "channel3.com";
    }
  }
  return "channel3.com";
}

export function formatAmount(amount: unknown): string {
  if (typeof amount === "number") {
    return Number.isInteger(amount) ? `${amount}.00` : amount.toFixed(2);
  }
  if (typeof amount === "string" && amount.trim().length > 0) {
    const parsed = parseFloat(amount.trim());
    if (!isNaN(parsed)) {
      return Number.isInteger(parsed) ? `${parsed}.00` : parsed.toFixed(2);
    }
    return amount.trim();
  }
  return "0.00";
}

export function extractSpecs(rawTitle: string): ProductSpecs {
  const t = rawTitle.toLowerCase();

  // 1. Brand detection
  let brand: string | undefined;
  if (/\bapple\b/.test(t)) brand = "Apple";
  else if (/\bsamsung\b/.test(t)) brand = "Samsung";
  else if (/\bgoogle\b/.test(t)) brand = "Google";
  else if (/\bxiaomi\b/.test(t)) brand = "Xiaomi";
  else if (/\bhuawei\b/.test(t)) brand = "Huawei";
  else if (/\bsony\b/.test(t)) brand = "Sony";
  else if (/\banker\b/.test(t)) brand = "Anker";
  else if (/\bspigen\b/.test(t)) brand = "Spigen";
  else if (/\bbelkin\b/.test(t)) brand = "Belkin";
  else if (/\botterbox\b/.test(t)) brand = "OtterBox";

  // 2. Device family detection
  let family: string | undefined;
  if (/\biphone\b/.test(t)) family = "iPhone";
  else if (/\bipad\b/.test(t)) family = "iPad";
  else if (/\bgalaxy\b/.test(t)) family = "Galaxy";
  else if (/\bpixel\b/.test(t)) family = "Pixel";
  else if (/\bmacbook\b/.test(t)) family = "MacBook";
  else if (/\bwatch\b/.test(t) || /часы/.test(t)) family = "Watch";

  // Infer device brand if accessory didn't specify distinct maker
  if (!brand) {
    if (family === "iPhone" || family === "iPad" || family === "MacBook") brand = "Apple";
    else if (family === "Galaxy") brand = "Samsung";
    else if (family === "Pixel") brand = "Google";
  }

  // 3. Model generation detection
  let generation: string | undefined;
  const iphoneMatch = t.match(/\biphone\s*(1[1-7]|[6-8]|se|x[rs]?)\b/);
  if (iphoneMatch) {
    generation = iphoneMatch[1].toUpperCase();
  } else {
    const galaxyMatch = t.match(/\bgalaxy\s*(s2[0-5]|s10|a\d{2}|z\s*(?:fold|flip)[1-6]?|note\s*20)\b/);
    if (galaxyMatch) {
      generation = galaxyMatch[1].toUpperCase().replace(/\s+/g, " ");
    } else {
      const pixelMatch = t.match(/\bpixel\s*([6-9]|fold|tablet)\b/);
      if (pixelMatch) {
        generation = pixelMatch[1].toUpperCase();
      }
    }
  }

  // Fallback: look for generation standalone number if family is known
  if (!generation && family === "iPhone") {
    const numMatch = t.match(/\b(1[1-7]|[6-8]|se|x[rs]?)\b/);
    if (numMatch) generation = numMatch[1].toUpperCase();
  }

  // 4. Tier detection
  let tier: string | undefined;
  if (/\bpro\s+max\b/.test(t)) tier = "Pro Max";
  else if (/\bpro\b/.test(t)) tier = "Pro";
  else if (/\bplus\b/.test(t)) tier = "Plus";
  else if (/\bultra\b/.test(t)) tier = "Ultra";
  else if (/\bmini\b/.test(t)) tier = "Mini";
  else if (/\bfe\b/.test(t)) tier = "FE";
  else if (/\blite\b/.test(t)) tier = "Lite";

  // 5. Category detection (EN + RU)
  let category: string | undefined;
  if (/\b(case|cover)\b/.test(t) || /чехол/.test(t)) category = "Case";
  else if (/\b(screen protector|tempered glass|glass)\b/.test(t) || /стекло/.test(t)) category = "Screen Protector";
  else if (/\b(charger|adapter|power bank)\b/.test(t) || /зарядк|адаптер/.test(t)) category = "Charger";
  else if (/\b(cable|cord)\b/.test(t) || /кабел/.test(t)) category = "Cable";
  else if (/\b(battery)\b/.test(t) || /аккумулятор|батаре/.test(t)) category = "Battery";

  // Build composite variant and compatibility identifiers
  const variantParts = [family, generation, tier].filter(Boolean);
  const variant = variantParts.length > 0 ? variantParts.join(" ") : undefined;
  const compatibility = variantParts.length > 1 ? variantParts.join(" ") : undefined;

  return {
    brand,
    family,
    generation,
    tier,
    category,
    variant,
    compatibility,
  };
}

export function matchChannel3Results(options: MatchChannel3Options): CatalogEnrichmentResult {
  const { productId, productTitle, products, shopCurrency } = options;
  const retrievedAt = options.retrievedAt ?? new Date().toISOString();

  // 0 results -> no_match
  if (!products || products.length === 0) {
    return catalogEnrichmentResult.parse({
      productId,
      productTitle,
      status: "no_match",
      message: "No matching reference products found",
    });
  }

  const querySpecs = extractSpecs(productTitle);

  // Check if query is just a brand with no model/variant/specs
  const isBrandOnlyQuery =
    Boolean(querySpecs.brand) &&
    !querySpecs.family &&
    !querySpecs.generation &&
    !querySpecs.tier &&
    !querySpecs.category;

  // Extract candidate specs and distinct variants
  const candidatesWithSpecs = products.map((p) => {
    const specs = extractSpecs(p.title);
    return { product: p, specs };
  });

  const distinctVariants = new Set<string>();
  for (const { specs } of candidatesWithSpecs) {
    if (specs.variant) {
      distinctVariants.add(specs.variant.toLowerCase());
    }
  }

  // Build ambiguous candidates list helper
  function buildAmbiguousCandidates(): AmbiguousCandidate[] {
    return products.slice(0, 5).map((p) => {
      const pSpecs = extractSpecs(p.title);
      const firstOffer = p.offers?.[0];
      const domain = firstOffer ? getDomain(firstOffer) : undefined;
      return {
        title: p.title.trim().slice(0, 300),
        ...(domain ? { domain: domain.slice(0, 255) } : {}),
        ...(pSpecs.variant ? { variantInfo: pSpecs.variant.slice(0, 200) } : {}),
      };
    });
  }

  // Rule: Brand match alone is insufficient. If query has only a brand, we never exact_match.
  if (isBrandOnlyQuery) {
    return catalogEnrichmentResult.parse({
      productId,
      productTitle,
      status: "ambiguous",
      message: "Brand match alone is insufficient. Specific model or variant required.",
      ambiguousCandidates: buildAmbiguousCandidates(),
    });
  }

  // Filter candidates compatible with query
  const compatibleCandidates: Array<{ product: Channel3Product; specs: ProductSpecs }> = [];

  for (const item of candidatesWithSpecs) {
    const { specs } = item;

    // Check device family incompatibility
    if (querySpecs.family && specs.family && querySpecs.family !== specs.family) {
      continue;
    }

    // Check category incompatibility (e.g. Case vs Screen Protector)
    if (querySpecs.category && specs.category && querySpecs.category !== specs.category) {
      continue;
    }

    // Check generation incompatibility (e.g. iPhone 15 vs iPhone 14)
    if (querySpecs.generation && specs.generation && querySpecs.generation !== specs.generation) {
      continue;
    }

    // Check tier incompatibility (e.g. Pro vs base or Ultra)
    if (querySpecs.tier && specs.tier && querySpecs.tier !== specs.tier) {
      continue;
    }

    compatibleCandidates.push(item);
  }

  // If no candidate is compatible -> no_match
  if (compatibleCandidates.length === 0) {
    return catalogEnrichmentResult.parse({
      productId,
      productTitle,
      status: "no_match",
      message: "No matching reference products found for the specified model",
    });
  }

  // Rule: If query lacked a specific generation/tier (e.g. "iPhone Case"),
  // and candidates span multiple conflicting variants (e.g. iPhone 14 and iPhone 15 Pro):
  // or if returned results contain multiple conflicting variants that both match:
  const compatibleVariants = new Set<string>();
  for (const { specs } of compatibleCandidates) {
    if (specs.variant) {
      compatibleVariants.add(specs.variant.toLowerCase());
    }
  }

  // If there are multiple conflicting variants among candidates
  if (distinctVariants.size > 1) {
    // If the query didn't have an exact generation & tier to resolve the conflict
    if (!querySpecs.generation || compatibleVariants.size > 1) {
      return catalogEnrichmentResult.parse({
        productId,
        productTitle,
        status: "ambiguous",
        message: "Multiple conflicting product variants found",
        ambiguousCandidates: buildAmbiguousCandidates(),
      });
    }
  }

  // If the query lacked specific model generation, but candidate has one:
  if (!querySpecs.generation && compatibleCandidates.some((c) => Boolean(c.specs.generation))) {
    return catalogEnrichmentResult.parse({
      productId,
      productTitle,
      status: "ambiguous",
      message: "Multiple potential models found for generic accessory query",
      ambiguousCandidates: buildAmbiguousCandidates(),
    });
  }

  // Exact match found!
  const bestMatch = compatibleCandidates[0].product;
  const bestSpecs = compatibleCandidates[0].specs;

  // Process reference prices without image downloads or external asset storage
  const referencePrices: ReferencePriceComparison[] = [];
  for (const offer of bestMatch.offers ?? []) {
    if (!offer || !offer.price) continue;
    const rawUrl = offer.url?.trim();
    if (!rawUrl || !isValidUrl(rawUrl)) continue;

    const domain = getDomain(offer);
    const amount = formatAmount(offer.price.amount);
    const currency = (offer.price.currency || "").trim().toUpperCase();
    if (!currency) continue;

    const isComparableCurrency = currency === shopCurrency.trim().toUpperCase();

    referencePrices.push({
      domain: domain.slice(0, 255),
      amount: amount.slice(0, 60),
      currency: currency.slice(0, 10),
      isComparableCurrency,
      url: rawUrl.slice(0, 1000),
      retrievedAt,
    });
  }

  // Process attributes
  const attributes: EnrichmentAttribute[] = [];
  if (Array.isArray(bestMatch.attributes)) {
    for (const attr of bestMatch.attributes) {
      if (attr && typeof attr.name === "string" && typeof attr.value === "string") {
        const name = attr.name.trim();
        const value = attr.value.trim();
        if (name && value) {
          attributes.push({
            name: name.slice(0, 100),
            value: value.slice(0, 500),
            ...(typeof attr.confidence === "number"
              ? { confidence: Math.min(1, Math.max(0, attr.confidence)) }
              : {}),
          });
        }
      }
    }
  } else if (bestMatch.attributes && typeof bestMatch.attributes === "object") {
    for (const [key, val] of Object.entries(bestMatch.attributes)) {
      if (key && typeof val === "string" && val.trim()) {
        attributes.push({
          name: key.trim().slice(0, 100),
          value: val.trim().slice(0, 500),
        });
      }
    }
  }

  // If attributes empty, populate factual specs
  if (attributes.length === 0) {
    if (bestSpecs.brand) attributes.push({ name: "Brand", value: bestSpecs.brand });
    if (bestSpecs.family) attributes.push({ name: "Device Family", value: bestSpecs.family });
    if (bestSpecs.variant) attributes.push({ name: "Model", value: bestSpecs.variant });
    if (bestSpecs.compatibility) attributes.push({ name: "Compatibility", value: bestSpecs.compatibility });
    if (bestSpecs.category) attributes.push({ name: "Category", value: bestSpecs.category });
  }

  let sourceDomain: string | undefined;
  let sourceUrl: string | undefined;

  if (referencePrices.length > 0) {
    sourceDomain = referencePrices[0].domain;
    sourceUrl = referencePrices[0].url;
  } else if (bestMatch.offers?.[0]?.url && isValidUrl(bestMatch.offers[0].url)) {
    sourceDomain = getDomain(bestMatch.offers[0]);
    sourceUrl = bestMatch.offers[0].url;
  }

  const suggestion: CatalogEnrichmentSuggestion = {
    canonicalTitle: bestMatch.title.trim().slice(0, 300),
    description: (bestMatch.description || "").trim().slice(0, 2000),
    attributes,
    referencePrices,
    ...(sourceDomain ? { sourceDomain: sourceDomain.slice(0, 255) } : {}),
    ...(sourceUrl ? { sourceUrl: sourceUrl.slice(0, 1000) } : {}),
    retrievedAt,
  };

  return catalogEnrichmentResult.parse({
    productId,
    productTitle,
    status: "exact_match",
    suggestion,
  });
}
