import { describe, expect, it, vi } from "vitest";
import { enrichCatalogProduct } from "./client";
import { extractSpecs, formatAmount, isValidUrl as requireIsValidUrl, matchChannel3Results } from "./matching";
import type { Channel3Product } from "./types";

const TEST_PRODUCT_ID = "11111111-1111-4111-a111-111111111111";

describe("Channel3 Catalog Enrichment", () => {
  describe("API Client & Error Handling", () => {
    it("returns not_configured status without throwing when API key is missing", async () => {
      const result = await enrichCatalogProduct({
        productId: TEST_PRODUCT_ID,
        productTitle: "iPhone 15 Pro Silicone Case",
        shopCurrency: "USD",
        apiKey: "",
      });

      expect(result.status).toBe("not_configured");
      expect(result.message).toBe("Channel3 API key not configured");
      expect(result.suggestion).toBeUndefined();
    });

    it("returns rate_limited status on HTTP 429", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("Too Many Requests", {
          status: 429,
          headers: { "content-type": "text/plain" },
        }),
      );

      const result = await enrichCatalogProduct({
        productId: TEST_PRODUCT_ID,
        productTitle: "iPhone 15 Pro Silicone Case",
        shopCurrency: "USD",
        apiKey: "test-api-key",
        fetch: mockFetch,
      });

      expect(result.status).toBe("rate_limited");
      expect(result.message).toContain("rate limit exceeded");
      expect(result.suggestion).toBeUndefined();
    });

    it("returns provider_error on authentication failure (HTTP 401 and 403)", async () => {
      for (const status of [401, 403]) {
        const mockFetch = vi.fn().mockResolvedValue(
          new Response("Unauthorized", {
            status,
            headers: { "content-type": "text/plain" },
          }),
        );

        const result = await enrichCatalogProduct({
          productId: TEST_PRODUCT_ID,
          productTitle: "iPhone 15 Pro Silicone Case",
          shopCurrency: "USD",
          apiKey: "invalid-key",
          fetch: mockFetch,
        });

        expect(result.status).toBe("provider_error");
        expect(result.message).toBe("Channel3 authentication failed");
        expect(result.suggestion).toBeUndefined();
      }
    });

    it("returns provider_error on HTTP 500 server error", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("Internal Server Error", {
          status: 500,
          headers: { "content-type": "text/plain" },
        }),
      );

      const result = await enrichCatalogProduct({
        productId: TEST_PRODUCT_ID,
        productTitle: "iPhone 15 Pro Silicone Case",
        shopCurrency: "USD",
        apiKey: "test-api-key",
        fetch: mockFetch,
      });

      expect(result.status).toBe("provider_error");
      expect(result.message).toBe("Channel3 provider unavailable");
      expect(result.suggestion).toBeUndefined();
    });

    it("returns provider_error on timeout or network error without throwing", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network connection aborted"));

      const result = await enrichCatalogProduct({
        productId: TEST_PRODUCT_ID,
        productTitle: "iPhone 15 Pro Silicone Case",
        shopCurrency: "USD",
        apiKey: "test-api-key",
        fetch: mockFetch,
      });

      expect(result.status).toBe("provider_error");
      expect(result.message).toBe("Channel3 provider unavailable");
      expect(result.suggestion).toBeUndefined();
    });

    it("sends correct headers, endpoint and body payload", async () => {
      let capturedUrl = "";
      let capturedInit: RequestInit | undefined;

      const mockFetch = vi.fn().mockImplementation((url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return Promise.resolve(
          new Response(JSON.stringify({ products: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      });

      await enrichCatalogProduct({
        productId: TEST_PRODUCT_ID,
        productTitle: "iPhone 15 Pro Case",
        query: "custom search query",
        shopCurrency: "USD",
        apiKey: "ch3_secret_123",
        endpoint: "https://api.trychannel3.com/v1/search",
        fetch: mockFetch,
      });

      expect(capturedUrl).toBe("https://api.trychannel3.com/v1/search");
      expect(capturedInit?.method).toBe("POST");
      expect((capturedInit?.headers as Record<string, string>)["x-api-key"]).toBe("ch3_secret_123");
      expect((capturedInit?.headers as Record<string, string>)["content-type"]).toBe(
        "application/json",
      );
      expect(JSON.parse(String(capturedInit?.body))).toEqual({
        query: "custom search query",
        limit: 5,
      });
    });

    it("rejects an oversized provider response without buffering it into JSON", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(`{"products":[]} ${" ".repeat(1024 * 1024)}`, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      const result = await enrichCatalogProduct({
        productId: TEST_PRODUCT_ID,
        productTitle: "iPhone 15 Pro Case",
        shopCurrency: "USD",
        apiKey: "test-api-key",
        fetch: mockFetch,
      });
      expect(result.status).toBe("provider_error");
    });
  });

  describe("Matching Logic & Specifications", () => {
    it("returns no_match when Channel3 returns 0 products", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ products: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      const result = await enrichCatalogProduct({
        productId: TEST_PRODUCT_ID,
        productTitle: "Rare Obsolete Cable",
        shopCurrency: "USD",
        apiKey: "test-api-key",
        fetch: mockFetch,
      });

      expect(result.status).toBe("no_match");
      expect(result.message).toContain("No matching");
      expect(result.suggestion).toBeUndefined();
    });

    it("returns no_match when products do not match device family or category", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            products: [
              {
                id: "p1",
                title: "Samsung Galaxy S24 Ultra Case",
                offers: [],
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

      const result = await enrichCatalogProduct({
        productId: TEST_PRODUCT_ID,
        productTitle: "iPhone 15 Pro Silicone Case",
        shopCurrency: "USD",
        apiKey: "test-api-key",
        fetch: mockFetch,
      });

      expect(result.status).toBe("no_match");
      expect(result.suggestion).toBeUndefined();
    });

    it("returns ambiguous with candidate list when multiple conflicting variants are found", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            products: [
              {
                id: "p1",
                title: "Чехол для iPhone 14",
                offers: [
                  {
                    domain: "target.com",
                    price: { price: 39.99, currency: "USD" },
                    availability: "InStock",
                    url: "https://target.com/p/iphone14",
                  },
                ],
              },
              {
                id: "p2",
                title: "Чехол для iPhone 15 Pro",
                offers: [
                  {
                    domain: "bestbuy.com",
                    price: { price: 49.99, currency: "USD" },
                    availability: "InStock",
                    url: "https://bestbuy.com/p/iphone15pro",
                  },
                ],
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

      const result = await enrichCatalogProduct({
        productId: TEST_PRODUCT_ID,
        productTitle: "Чехол для iPhone",
        shopCurrency: "USD",
        apiKey: "test-api-key",
        fetch: mockFetch,
      });

      expect(result.status).toBe("ambiguous");
      expect(result.suggestion).toBeUndefined();
      expect(result.ambiguousCandidates).toBeDefined();
      expect(result.ambiguousCandidates).toHaveLength(2);

      const [c1, c2] = result.ambiguousCandidates!;
      expect(c1.title).toBe("Чехол для iPhone 14");
      expect(c1.variantInfo).toContain("iPhone 14");
      expect(c1.domain).toBe("target.com");

      expect(c2.title).toBe("Чехол для iPhone 15 Pro");
      expect(c2.variantInfo).toContain("iPhone 15 Pro");
      expect(c2.domain).toBe("bestbuy.com");
    });

    it("returns ambiguous when query is brand-only without model specifications", async () => {
      const mockProducts: Channel3Product[] = [
        {
          id: "p1",
          title: "Apple iPhone 15 Pro Silicone Case",
          offers: [{ domain: "apple.com", price: { price: 49, currency: "USD" }, url: "https://apple.com" }],
        },
      ];

      const result = matchChannel3Results({
        productId: TEST_PRODUCT_ID,
        productTitle: "Apple",
        products: mockProducts,
        shopCurrency: "USD",
      });

      expect(result.status).toBe("ambiguous");
      expect(result.message).toContain("Brand match alone is insufficient");
      expect(result.ambiguousCandidates).toBeDefined();
    });

    it("returns exact_match with canonical specifications and reference prices", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            products: [
              {
                id: "p1",
                title: "Apple iPhone 15 Pro Silicone Case with MagSafe - Black",
                description: "Designed by Apple to complement iPhone 15 Pro.",
                offers: [
                  {
                    domain: "target.com",
                    price: { price: 49.0, currency: "USD" },
                    availability: "InStock",
                    url: "https://www.target.com/p/iphone-15-pro-case/-/A-123456",
                  },
                  {
                    domain: "bestbuy.com",
                    price: { price: 49.99, currency: "USD" },
                    availability: "InStock",
                    url: "https://www.bestbuy.com/site/apple-iphone-15-pro-case/654321.p",
                  },
                ],
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

      const result = await enrichCatalogProduct({
        productId: TEST_PRODUCT_ID,
        productTitle: "Apple iPhone 15 Pro Silicone Case",
        shopCurrency: "USD",
        apiKey: "test-api-key",
        fetch: mockFetch,
      });

      expect(result.status).toBe("exact_match");
      expect(result.suggestion).toBeDefined();
      expect(result.ambiguousCandidates).toBeUndefined();

      const suggestion = result.suggestion!;
      expect(suggestion.canonicalTitle).toBe(
        "Apple iPhone 15 Pro Silicone Case with MagSafe - Black",
      );
      expect(suggestion.description).toBe("Designed by Apple to complement iPhone 15 Pro.");
      expect(suggestion.sourceDomain).toBe("www.target.com");
      expect(suggestion.sourceUrl).toBe("https://www.target.com/p/iphone-15-pro-case/-/A-123456");

      // Verify reference prices
      expect(suggestion.referencePrices).toHaveLength(2);
      expect(suggestion.referencePrices[0]).toEqual({
        domain: "www.target.com",
        amount: "49.00",
        currency: "USD",
        isComparableCurrency: true,
        url: "https://www.target.com/p/iphone-15-pro-case/-/A-123456",
        retrievedAt: expect.any(String),
      });

      expect(suggestion.referencePrices[1]).toEqual({
        domain: "www.bestbuy.com",
        amount: "49.99",
        currency: "USD",
        isComparableCurrency: true,
        url: "https://www.bestbuy.com/site/apple-iphone-15-pro-case/654321.p",
        retrievedAt: expect.any(String),
      });

      // Verify factual attributes
      expect(suggestion.attributes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "Brand", value: "Apple" }),
          expect.objectContaining({ name: "Model", value: "iPhone 15 Pro" }),
          expect.objectContaining({ name: "Compatibility", value: "iPhone 15 Pro" }),
        ]),
      );
    });

    it("correctly flags isComparableCurrency false when shop currency differs, with no auto-conversion", async () => {
      const mockProducts: Channel3Product[] = [
        {
          id: "p1",
          title: "Apple iPhone 15 Pro Silicone Case",
          offers: [
            {
              domain: "amazon.com",
              price: { price: 49.0, currency: "USD" },
              url: "https://amazon.com/dp/B012345",
            },
            {
              domain: "amazon.de",
              price: { price: 55.0, currency: "EUR" },
              url: "https://amazon.de/dp/B012345",
            },
          ],
        },
      ];

      // Shop currency is EUR
      const result = matchChannel3Results({
        productId: TEST_PRODUCT_ID,
        productTitle: "Apple iPhone 15 Pro Silicone Case",
        products: mockProducts,
        shopCurrency: "EUR",
      });

      expect(result.status).toBe("exact_match");
      const prices = result.suggestion!.referencePrices;
      expect(prices).toHaveLength(2);

      // USD offer is not comparable to EUR shop
      const usdOffer = prices.find((p) => p.currency === "USD")!;
      expect(usdOffer.isComparableCurrency).toBe(false);
      expect(usdOffer.amount).toBe("49.00");

      // EUR offer is comparable to EUR shop
      const eurOffer = prices.find((p) => p.currency === "EUR")!;
      expect(eurOffer.isComparableCurrency).toBe(true);
      expect(eurOffer.amount).toBe("55.00");
    });

    it("does not exact-match a different accessory brand or a missing requested tier", () => {
      const differentBrand = matchChannel3Results({
        productId: TEST_PRODUCT_ID,
        productTitle: "Anker case for iPhone 15 Pro",
        shopCurrency: "USD",
        products: [{ id: "c3-1", title: "Spigen case for iPhone 15 Pro", offers: [] }],
      });
      expect(differentBrand.status).toBe("no_match");

      const missingTier = matchChannel3Results({
        productId: TEST_PRODUCT_ID,
        productTitle: "iPhone 15 Pro case",
        shopCurrency: "USD",
        products: [{ id: "c3-2", title: "iPhone 15 case", offers: [] }],
      });
      expect(missingTier.status).toBe("ambiguous");
      expect(missingTier.suggestion).toBeUndefined();
    });

    it("uses Channel3's nested offer price.price field", () => {
      const result = matchChannel3Results({
        productId: TEST_PRODUCT_ID,
        productTitle: "Apple iPhone 15 Pro Silicone Case",
        shopCurrency: "USD",
        products: [{
          id: "c3-3",
          title: "Apple iPhone 15 Pro Silicone Case",
          brands: [{ id: "apple", name: "Apple" }],
          offers: [{ domain: "example.com", price: { price: 49.99, currency: "USD" }, url: "https://example.com/item" }],
        }],
      });
      expect(result.status).toBe("exact_match");
      expect(result.suggestion?.referencePrices[0].amount).toBe("49.99");
    });
  });

  describe("Spec Extraction & Formatting Utilities", () => {
    it("extracts phone models and accessories in Russian and English", () => {
      const en = extractSpecs("Apple iPhone 15 Pro Max Clear Case");
      expect(en.brand).toBe("Apple");
      expect(en.family).toBe("iPhone");
      expect(en.generation).toBe("15");
      expect(en.tier).toBe("Pro Max");
      expect(en.category).toBe("Case");
      expect(en.variant).toBe("iPhone 15 Pro Max");

      const ru = extractSpecs("Защитное стекло для iPhone 14 Pro");
      expect(en.family).toBe("iPhone");
      expect(ru.generation).toBe("14");
      expect(ru.tier).toBe("Pro");
      expect(ru.category).toBe("Screen Protector");
    });

    it("rejects external URLs with non-web schemes or embedded credentials", () => {
      expect(extractSpecs).toBeDefined();
      expect(matchChannel3Results).toBeDefined();
      expect(requireIsValidUrl("javascript:alert(1)")).toBe(false);
      expect(requireIsValidUrl("https://user:pass@example.com/item")).toBe(false);
      expect(requireIsValidUrl("data:text/html,hello")).toBe(false);
    });

    it("formats amounts cleanly without floating point precision artifacts", () => {
      expect(formatAmount(49)).toBe("49.00");
      expect(formatAmount(49.5)).toBe("49.50");
      expect(formatAmount(49.99)).toBe("49.99");
      expect(formatAmount("24.9")).toBe("24.90");
      expect(formatAmount("24.99")).toBe("24.99");
      expect(formatAmount(null)).toBe("");
      expect(formatAmount("1,234.56")).toBe("");
      expect(formatAmount("49.99")).toBe("49.99");
    });
  });
});
