import { beforeEach, describe, expect, it, vi } from "vitest";

import { currentSeller } from "@/server/auth/current-seller";
import { enrichCatalogProduct } from "@/server/channel3/client";
import { getDb } from "@/server/db";
import { ServiceError } from "@/server/errors";
import { GET, POST } from "./route";

vi.mock("server-only", () => ({}));

vi.mock("@/server/auth/current-seller", () => ({
  currentSeller: vi.fn(),
}));

vi.mock("@/server/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/server/channel3/client", () => ({
  enrichCatalogProduct: vi.fn(),
}));

const SHOP_ID = "22222222-2222-4222-a222-222222222222";
const PRODUCT_ID = "11111111-1111-4111-a111-111111111111";

const mockShop = {
  id: SHOP_ID,
  slug: "test-repair-shop",
  name: "Test Repair Shop",
  currency: "EUR",
  timezone: "UTC",
};

function mockDb(rows: unknown[] = []) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

describe("GET /api/seller/catalog/[id]/enrichment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when seller is not authenticated", async () => {
    vi.mocked(currentSeller).mockRejectedValue(
      new ServiceError("UNAUTHORIZED", "Sign in to this shop first."),
    );

    const req = new Request(`https://agentshelf.test/api/seller/catalog/${PRODUCT_ID}/enrichment`);
    const res = await GET(req, { params: Promise.resolve({ id: PRODUCT_ID }) });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 when product id is not a valid UUID", async () => {
    vi.mocked(currentSeller).mockResolvedValue(mockShop as any);

    const req = new Request("https://agentshelf.test/api/seller/catalog/not-a-uuid/enrichment");
    const res = await GET(req, { params: Promise.resolve({ id: "not-a-uuid" }) });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("PRODUCT_NOT_FOUND");
  });

  it("returns 404 when product is not found in shop catalog", async () => {
    vi.mocked(currentSeller).mockResolvedValue(mockShop as any);
    vi.mocked(getDb).mockReturnValue(mockDb([]) as any);

    const req = new Request(`https://agentshelf.test/api/seller/catalog/${PRODUCT_ID}/enrichment`);
    const res = await GET(req, { params: Promise.resolve({ id: PRODUCT_ID }) });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("PRODUCT_NOT_FOUND");
  });

  it("returns 200 with enrichment result on valid product", async () => {
    vi.mocked(currentSeller).mockResolvedValue(mockShop as any);
    vi.mocked(getDb).mockReturnValue(
      mockDb([{ id: PRODUCT_ID, title: "iPhone 15 Pro Case", shopId: SHOP_ID }]) as any,
    );
    vi.mocked(enrichCatalogProduct).mockResolvedValue({
      productId: PRODUCT_ID,
      productTitle: "iPhone 15 Pro Case",
      status: "exact_match",
      suggestion: {
        canonicalTitle: "Apple iPhone 15 Pro Silicone Case",
        description: "Official Apple Case",
        attributes: [{ name: "Brand", value: "Apple" }],
        referencePrices: [
          {
            domain: "target.com",
            amount: "49.00",
            currency: "EUR",
            isComparableCurrency: true,
            url: "https://target.com/p/123",
            retrievedAt: new Date().toISOString(),
          },
        ],
        sourceDomain: "target.com",
        sourceUrl: "https://target.com/p/123",
        retrievedAt: new Date().toISOString(),
      },
    });

    const req = new Request(`https://agentshelf.test/api/seller/catalog/${PRODUCT_ID}/enrichment`);
    const res = await GET(req, { params: Promise.resolve({ id: PRODUCT_ID }) });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("exact_match");
    expect(body.productId).toBe(PRODUCT_ID);
    expect(vi.mocked(enrichCatalogProduct)).toHaveBeenCalledWith({
      productId: PRODUCT_ID,
      productTitle: "iPhone 15 Pro Case",
      query: undefined,
      shopCurrency: "EUR",
    });
  });

  it("passes query parameter from URL search params", async () => {
    vi.mocked(currentSeller).mockResolvedValue(mockShop as any);
    vi.mocked(getDb).mockReturnValue(
      mockDb([{ id: PRODUCT_ID, title: "iPhone Case", shopId: SHOP_ID }]) as any,
    );
    vi.mocked(enrichCatalogProduct).mockResolvedValue({
      productId: PRODUCT_ID,
      productTitle: "iPhone Case",
      status: "no_match",
    });

    const req = new Request(
      `https://agentshelf.test/api/seller/catalog/${PRODUCT_ID}/enrichment?query=iPhone+15+Pro`,
    );
    const res = await GET(req, { params: Promise.resolve({ id: PRODUCT_ID }) });

    expect(res.status).toBe(200);
    expect(vi.mocked(enrichCatalogProduct)).toHaveBeenCalledWith({
      productId: PRODUCT_ID,
      productTitle: "iPhone Case",
      query: "iPhone 15 Pro",
      shopCurrency: "EUR",
    });
  });
});

describe("POST /api/seller/catalog/[id]/enrichment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes query from request body override", async () => {
    vi.mocked(currentSeller).mockResolvedValue(mockShop as any);
    vi.mocked(getDb).mockReturnValue(
      mockDb([{ id: PRODUCT_ID, title: "iPhone Case", shopId: SHOP_ID }]) as any,
    );
    vi.mocked(enrichCatalogProduct).mockResolvedValue({
      productId: PRODUCT_ID,
      productTitle: "iPhone Case",
      status: "exact_match",
    });

    const req = new Request(`https://agentshelf.test/api/seller/catalog/${PRODUCT_ID}/enrichment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Apple iPhone 15 Pro Silicone Case" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: PRODUCT_ID }) });

    expect(res.status).toBe(200);
    expect(vi.mocked(enrichCatalogProduct)).toHaveBeenCalledWith({
      productId: PRODUCT_ID,
      productTitle: "iPhone Case",
      query: "Apple iPhone 15 Pro Silicone Case",
      shopCurrency: "EUR",
    });
  });

  it("works with empty POST body", async () => {
    vi.mocked(currentSeller).mockResolvedValue(mockShop as any);
    vi.mocked(getDb).mockReturnValue(
      mockDb([{ id: PRODUCT_ID, title: "iPhone 15 Pro Case", shopId: SHOP_ID }]) as any,
    );
    vi.mocked(enrichCatalogProduct).mockResolvedValue({
      productId: PRODUCT_ID,
      productTitle: "iPhone 15 Pro Case",
      status: "exact_match",
    });

    const req = new Request(`https://agentshelf.test/api/seller/catalog/${PRODUCT_ID}/enrichment`, {
      method: "POST",
    });
    const res = await POST(req, { params: Promise.resolve({ id: PRODUCT_ID }) });

    expect(res.status).toBe(200);
    expect(vi.mocked(enrichCatalogProduct)).toHaveBeenCalledWith({
      productId: PRODUCT_ID,
      productTitle: "iPhone 15 Pro Case",
      query: undefined,
      shopCurrency: "EUR",
    });
  });
});
