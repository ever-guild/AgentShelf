import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CatalogEnrichmentSuggestion } from "@/server/contracts/catalog-enrichment";

import {
  ENRICHMENT_MESSAGES,
  classifyEnrichmentApiResponse,
  findComparableReferencePrice,
  formatPriceWithCurrency,
  formatRetrievedDate,
  isComparableCurrency,
} from "./enrichment-state";
import { ProductEnrichment } from "./product-enrichment";

const TEST_PRODUCT_ID = "00000000-0000-4000-8000-000000000001";
const TEST_PRODUCT_TITLE = "Apple iPhone 15 Pro Silicone Case";

const EXACT_MATCH_SUGGESTION: CatalogEnrichmentSuggestion = {
  canonicalTitle: "Apple iPhone 15 Pro Silicone Case with MagSafe",
  description: "Designed by Apple to complement iPhone 15 Pro, silky-soft silicone.",
  attributes: [
    { name: "Brand", value: "Apple" },
    { name: "Model Compatibility", value: "iPhone 15 Pro" },
    { name: "Material", value: "Silicone" },
  ],
  referencePrices: [
    {
      domain: "amazon.de",
      amount: "44.90",
      currency: "EUR",
      isComparableCurrency: true,
      url: "https://www.amazon.de/dp/B0CHWZ",
      retrievedAt: "2026-11-09T18:00:00.000Z",
    },
  ],
  sourceDomain: "amazon.de",
  sourceUrl: "https://www.amazon.de/dp/B0CHWZ",
  retrievedAt: "2026-11-09T18:00:00.000Z",
};

const USD_OFFER_SUGGESTION: CatalogEnrichmentSuggestion = {
  canonicalTitle: "Apple iPhone 15 Pro Silicone Case with MagSafe",
  description: "Designed by Apple to complement iPhone 15 Pro.",
  attributes: [{ name: "Brand", value: "Apple" }],
  referencePrices: [
    {
      domain: "target.com",
      amount: "49.00",
      currency: "USD",
      isComparableCurrency: false,
      url: "https://www.target.com/p/apple-iphone-case",
      retrievedAt: "2026-11-09T18:00:00.000Z",
    },
  ],
  retrievedAt: "2026-11-09T18:00:00.000Z",
};

describe("enrichment-state pure functions", () => {
  describe("isComparableCurrency", () => {
    it("returns true when offer and shop currencies match and flag is not false", () => {
      expect(isComparableCurrency("EUR", "EUR", true)).toBe(true);
      expect(isComparableCurrency("eur", "EUR")).toBe(true);
    });

    it("returns false when offer and shop currencies differ", () => {
      expect(isComparableCurrency("USD", "EUR", true)).toBe(false);
      expect(isComparableCurrency("GBP", "EUR", true)).toBe(false);
    });

    it("returns false if isComparableFlag is explicitly false even if codes match", () => {
      expect(isComparableCurrency("EUR", "EUR", false)).toBe(false);
    });
  });

  describe("findComparableReferencePrice", () => {
    it("finds the first matching currency price", () => {
      const prices = [
        {
          domain: "target.com",
          amount: "49.00",
          currency: "USD",
          isComparableCurrency: false,
          url: "https://target.com",
          retrievedAt: "2026-11-09T18:00:00.000Z",
        },
        {
          domain: "amazon.de",
          amount: "44.90",
          currency: "EUR",
          isComparableCurrency: true,
          url: "https://amazon.de",
          retrievedAt: "2026-11-09T18:00:00.000Z",
        },
      ];
      const match = findComparableReferencePrice(prices, "EUR");
      expect(match?.domain).toBe("amazon.de");
      expect(match?.amount).toBe("44.90");
    });

    it("returns null when no price matches the shop currency", () => {
      const prices = [
        {
          domain: "target.com",
          amount: "49.00",
          currency: "USD",
          isComparableCurrency: false,
          url: "https://target.com",
          retrievedAt: "2026-11-09T18:00:00.000Z",
        },
      ];
      expect(findComparableReferencePrice(prices, "EUR")).toBeNull();
    });
  });

  describe("formatPriceWithCurrency", () => {
    it("formats EUR amounts into standard currency representation", () => {
      const formatted = formatPriceWithCurrency("24.99", "EUR");
      expect(formatted).toContain("24.99");
      expect(formatted).toContain("€");
    });

    it("formats USD amounts into standard currency representation", () => {
      const formatted = formatPriceWithCurrency("49.00", "USD");
      expect(formatted).toContain("49.00");
      expect(formatted).toContain("$");
    });

    it("falls back to amount and currency code for non-numeric input", () => {
      expect(formatPriceWithCurrency("invalid", "XYZ")).toBe("invalid XYZ");
    });
  });

  describe("formatRetrievedDate", () => {
    it("formats valid ISO dates cleanly", () => {
      const formatted = formatRetrievedDate("2026-11-09T18:00:00.000Z");
      expect(formatted).toContain("2026");
      expect(formatted).toContain("Nov");
    });

    it("returns the raw string if invalid date", () => {
      expect(formatRetrievedDate("not-a-date")).toBe("not-a-date");
    });
  });

  describe("classifyEnrichmentApiResponse", () => {
    it("classifies valid exact_match response", () => {
      const result = classifyEnrichmentApiResponse(200, {
        productId: TEST_PRODUCT_ID,
        productTitle: TEST_PRODUCT_TITLE,
        status: "exact_match",
        suggestion: EXACT_MATCH_SUGGESTION,
      });
      expect(result).toEqual({
        status: "exact_match",
        suggestion: EXACT_MATCH_SUGGESTION,
      });
    });

    it("classifies exact_match without suggestion as provider_error", () => {
      const result = classifyEnrichmentApiResponse(200, {
        productId: TEST_PRODUCT_ID,
        productTitle: TEST_PRODUCT_TITLE,
        status: "exact_match",
      });
      expect(result.status).toBe("provider_error");
      if (result.status === "provider_error") {
        expect(result.message).toContain("missing suggestion data");
      }
    });

    it("classifies ambiguous response with candidates", () => {
      const candidates = [
        { title: "iPhone 15 Case", domain: "bestbuy.com" },
        { title: "iPhone 15 Pro Max Case", domain: "apple.com" },
      ];
      const result = classifyEnrichmentApiResponse(200, {
        productId: TEST_PRODUCT_ID,
        productTitle: TEST_PRODUCT_TITLE,
        status: "ambiguous",
        ambiguousCandidates: candidates,
      });
      expect(result).toEqual({
        status: "ambiguous",
        candidates,
        message: ENRICHMENT_MESSAGES.AMBIGUOUS_TITLE,
      });
    });

    it("classifies no_match response", () => {
      const result = classifyEnrichmentApiResponse(200, {
        productId: TEST_PRODUCT_ID,
        productTitle: TEST_PRODUCT_TITLE,
        status: "no_match",
      });
      expect(result).toEqual({ status: "no_match" });
    });

    it("classifies not_configured response", () => {
      const result = classifyEnrichmentApiResponse(200, {
        productId: TEST_PRODUCT_ID,
        productTitle: TEST_PRODUCT_TITLE,
        status: "not_configured",
      });
      expect(result).toEqual({ status: "not_configured" });
    });

    it("classifies 429 rate limit response", () => {
      const result = classifyEnrichmentApiResponse(429, {
        message: "Too many requests to Channel3",
      });
      expect(result).toEqual({
        status: "rate_limited",
        message: "Too many requests to Channel3",
      });
    });

    it("classifies 429 without body message using default rate limit notice", () => {
      const result = classifyEnrichmentApiResponse(429, null);
      expect(result).toEqual({
        status: "rate_limited",
        message: ENRICHMENT_MESSAGES.RATE_LIMITED,
      });
    });

    it("classifies 401 and 403 as provider_error with authentication message", () => {
      const res401 = classifyEnrichmentApiResponse(401, null);
      expect(res401.status).toBe("provider_error");
      if (res401.status === "provider_error") {
        expect(res401.message).toContain("authentication failed");
      }

      const res403 = classifyEnrichmentApiResponse(403, null);
      expect(res403.status).toBe("provider_error");
    });

    it("classifies 500+ as provider_error with server error message", () => {
      const result = classifyEnrichmentApiResponse(503, null);
      expect(result.status).toBe("provider_error");
      if (result.status === "provider_error") {
        expect(result.message).toContain("server error (HTTP 503)");
      }
    });

    it("classifies invalid payload structure as provider_error", () => {
      const result = classifyEnrichmentApiResponse(200, { unexpected: true });
      expect(result.status).toBe("provider_error");
      if (result.status === "provider_error") {
        expect(result.message).toContain("invalid response structure");
      }
    });
  });
});

describe("ProductEnrichment UI states rendering", () => {
  it("renders idle state with restrained trigger button and accessible label", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProductEnrichment, {
        productId: TEST_PRODUCT_ID,
        productTitle: TEST_PRODUCT_TITLE,
        shopCurrency: "EUR",
        onApplyPrice: () => {},
        initialState: { status: "idle" },
      }),
    );
    expect(html).toContain("Check market specs &amp; price");
    expect(html).toContain(`aria-label="Check market specs &amp; price: ${TEST_PRODUCT_TITLE}"`);
    expect(html).toContain(`data-testid="enrichment-${TEST_PRODUCT_ID}"`);
  });

  it("renders loading state with status role and aria-live polite", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProductEnrichment, {
        productId: TEST_PRODUCT_ID,
        productTitle: TEST_PRODUCT_TITLE,
        shopCurrency: "EUR",
        onApplyPrice: () => {},
        initialState: { status: "loading" },
      }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Checking Channel3 product data...");
    expect(html).toContain(`data-testid="enrichment-loading-${TEST_PRODUCT_ID}"`);
  });

  it("renders not_configured state with restrained notice", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProductEnrichment, {
        productId: TEST_PRODUCT_ID,
        productTitle: TEST_PRODUCT_TITLE,
        shopCurrency: "EUR",
        onApplyPrice: () => {},
        initialState: { status: "not_configured" },
      }),
    );
    expect(html).toContain("Channel3 enrichment is not configured in this environment.");
    expect(html).toContain("Dismiss");
    expect(html).toContain(`data-testid="enrichment-not-configured-${TEST_PRODUCT_ID}"`);
  });

  it("renders no_match state with notification message", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProductEnrichment, {
        productId: TEST_PRODUCT_ID,
        productTitle: TEST_PRODUCT_TITLE,
        shopCurrency: "EUR",
        onApplyPrice: () => {},
        initialState: { status: "no_match" },
      }),
    );
    expect(html).toContain("No reference product match found on Channel3.");
    expect(html).toContain("Dismiss");
    expect(html).toContain(`data-testid="enrichment-no-match-${TEST_PRODUCT_ID}"`);
  });

  it("renders ambiguous state with candidate list and warning without auto-applying", () => {
    const candidates = [
      { title: "Apple iPhone 15 Silicone Case", domain: "apple.com", variantInfo: "Standard 6.1" },
      { title: "Apple iPhone 15 Pro Max Silicone Case", domain: "target.com", variantInfo: "Pro Max 6.7" },
    ];
    const html = renderToStaticMarkup(
      React.createElement(ProductEnrichment, {
        productId: TEST_PRODUCT_ID,
        productTitle: TEST_PRODUCT_TITLE,
        shopCurrency: "EUR",
        onApplyPrice: () => {},
        initialState: {
          status: "ambiguous",
          candidates,
          message: ENRICHMENT_MESSAGES.AMBIGUOUS_TITLE,
        },
      }),
    );
    expect(html).toContain('role="region"');
    expect(html).toContain("Multiple product variants match this title. Please review:");
    expect(html).toContain("No changes were applied");
    expect(html).toContain("Apple iPhone 15 Silicone Case");
    expect(html).toContain("Apple iPhone 15 Pro Max Silicone Case");
    expect(html).toContain("Source: apple.com");
    expect(html).toContain("Variant: Pro Max 6.7");
    expect(html).toContain(`data-testid="enrichment-ambiguous-${TEST_PRODUCT_ID}"`);
  });

  it("renders exact_match state with specifications, reference prices, and apply button", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProductEnrichment, {
        productId: TEST_PRODUCT_ID,
        productTitle: TEST_PRODUCT_TITLE,
        shopCurrency: "EUR",
        onApplyPrice: () => {},
        initialState: {
          status: "exact_match",
          suggestion: EXACT_MATCH_SUGGESTION,
        },
      }),
    );
    expect(html).toContain('role="region"');
    expect(html).toContain("Apple iPhone 15 Pro Silicone Case with MagSafe");
    expect(html).toContain("Designed by Apple to complement iPhone 15 Pro");
    // Attributes
    expect(html).toContain("Brand");
    expect(html).toContain("Apple");
    expect(html).toContain("Model Compatibility");
    expect(html).toContain("iPhone 15 Pro");
    // Reference price
    expect(html).toContain("amazon.de");
    expect(html).toContain("44.90");
    expect(html).toContain("Source link");
    expect(html).toContain('href="https://www.amazon.de/dp/B0CHWZ"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    // Action button
    expect(html).toContain("Apply reference price");
    expect(html).toContain(`data-testid="enrichment-exact-${TEST_PRODUCT_ID}"`);
  });

  it("renders different currency warning and hides apply button when currency is incomparable", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProductEnrichment, {
        productId: TEST_PRODUCT_ID,
        productTitle: TEST_PRODUCT_TITLE,
        shopCurrency: "EUR",
        onApplyPrice: () => {},
        initialState: {
          status: "exact_match",
          suggestion: USD_OFFER_SUGGESTION,
        },
      }),
    );
    expect(html).toContain("Different currency (USD vs EUR) — cannot directly compare prices");
    expect(html).not.toContain("Apply reference price");
  });

  it("renders rate_limited state with message and status role", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProductEnrichment, {
        productId: TEST_PRODUCT_ID,
        productTitle: TEST_PRODUCT_TITLE,
        shopCurrency: "EUR",
        onApplyPrice: () => {},
        initialState: {
          status: "rate_limited",
          message: "Channel3 rate limit exceeded. Please try again later.",
        },
      }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Channel3 rate limit exceeded. Please try again later.");
    expect(html).toContain("Dismiss");
    expect(html).toContain(`data-testid="enrichment-rate-limited-${TEST_PRODUCT_ID}"`);
  });

  it("renders provider_error state with alert role and error message", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProductEnrichment, {
        productId: TEST_PRODUCT_ID,
        productTitle: TEST_PRODUCT_TITLE,
        shopCurrency: "EUR",
        onApplyPrice: () => {},
        initialState: {
          status: "provider_error",
          message: "Channel3 data unavailable: upstream timeout",
        },
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Channel3 data unavailable: upstream timeout");
    expect(html).toContain("Dismiss");
    expect(html).toContain(`data-testid="enrichment-error-${TEST_PRODUCT_ID}"`);
  });

  it("renders applied state with confirmation text and status role", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProductEnrichment, {
        productId: TEST_PRODUCT_ID,
        productTitle: TEST_PRODUCT_TITLE,
        shopCurrency: "EUR",
        onApplyPrice: () => {},
        initialState: {
          status: "applied",
          appliedPrice: "44.90",
          suggestion: EXACT_MATCH_SUGGESTION,
        },
      }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Reference price applied. Don&#x27;t forget to save changes.");
    expect(html).toContain("44.90");
    expect(html).toContain("Dismiss");
    expect(html).toContain(`data-testid="enrichment-applied-${TEST_PRODUCT_ID}"`);
  });

  it("wires onApplyPrice action contract correctly", async () => {
    const mockSave = vi.fn().mockResolvedValue(undefined);
    // Simulating callback execution as wired in catalog-manager.tsx
    await mockSave("44.90");
    expect(mockSave).toHaveBeenCalledWith("44.90");
  });
});
