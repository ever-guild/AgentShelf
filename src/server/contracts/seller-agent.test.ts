import { describe, expect, it } from "vitest";

import {
  sellerAgentCatalogInput,
  sellerAgentCatalogResult,
  sellerAgentCreateShopInput,
  sellerAgentPayPalConnectResult,
  sellerAgentReviewResult,
  sellerAgentStockInput,
} from "./seller-agent";

describe("seller agent contracts", () => {
  it("rejects tenant IDs and payment routing fields from shop registration", () => {
    const input = {
      shop: { name: "Workshop", slug: "workshop", location: "Liepaja", currency: "EUR", timezone: "Europe/Riga" },
      idempotencyKey: "4f4b2190-f88b-4d19-bef6-cc11e71bb6f1",
      shopId: "5f4b2190-f88b-4d19-bef6-cc11e71bb6f1",
      payee: "merchant-controlled-by-agent",
    };
    expect(sellerAgentCreateShopInput.safeParse(input).success).toBe(false);
  });

  it("requires operation-specific catalog inputs and rejects unrelated fields", () => {
    expect(sellerAgentCatalogInput.safeParse({ action: "create" }).success).toBe(false);
    expect(sellerAgentCatalogInput.safeParse({ action: "list", shopId: "elsewhere" }).success).toBe(false);
    expect(sellerAgentCatalogInput.safeParse({ action: "edit", productId: "5f4b2190-f88b-4d19-bef6-cc11e71bb6f1", patch: { price: "12.00" } }).success).toBe(true);
    expect(sellerAgentCatalogInput.safeParse({ action: "edit", productId: "5f4b2190-f88b-4d19-bef6-cc11e71bb6f1", patch: { price: "12.00", payee: "x" } }).success).toBe(false);
  });

  it("requires an idempotent, versioned, explained nonzero stock adjustment", () => {
    const productId = "5f4b2190-f88b-4d19-bef6-cc11e71bb6f1";
    expect(sellerAgentStockInput.safeParse({ action: "read", productId }).success).toBe(true);
    expect(sellerAgentStockInput.safeParse({ action: "adjust", productId, delta: 1, expectedVersion: 0, idempotencyKey: "0123456789abcdef", reason: "Restocked" }).success).toBe(true);
    expect(sellerAgentStockInput.safeParse({ action: "adjust", productId, delta: 0, expectedVersion: 0, idempotencyKey: "0123456789abcdef", reason: "Restocked" }).success).toBe(false);
    expect(sellerAgentStockInput.safeParse({ action: "adjust", productId, delta: 1, expectedVersion: 0, idempotencyKey: "short", reason: "Restocked" }).success).toBe(false);
    expect(sellerAgentStockInput.safeParse({ action: "read", productId, shopId: "elsewhere" }).success).toBe(false);
  });

  it("accepts only the PayPal sandbox consent link in seller connection output", () => {
    expect(sellerAgentPayPalConnectResult.safeParse({
      status: "pending",
      nextAction: "continue_paypal",
      humanActionUrl: "https://www.sandbox.paypal.com/us/merchantsignup/partner/onboardingentry?token=action-token",
    }).success).toBe(true);
    for (const humanActionUrl of [
      "https://www.paypal.com/merchantsignup/partner/onboardingentry?token=action-token",
      "https://attacker@sandbox.paypal.com/merchantsignup/partner/onboardingentry?token=action-token",
      "https://www.sandbox.paypal.com:444/merchantsignup/partner/onboardingentry?token=action-token",
      "https://www.sandbox.paypal.com/merchantsignup/partner/onboardingentry?token=action-token#fragment",
      "https://www.sandbox.paypal.com/other/path?token=action-token",
      "https://www.sandbox.paypal.com/merchantsignup/partner/onboardingentry",
    ]) {
      expect(sellerAgentPayPalConnectResult.safeParse({ status: "pending", humanActionUrl }).success).toBe(false);
    }
  });

  it("redacts provider identifiers and rejects unmodeled seller output fields", () => {
    const product = {
      id: "5f4b2190-f88b-4d19-bef6-cc11e71bb6f1",
      kind: "product",
      status: "published",
      title: "Cable",
      description: "USB-C cable",
      descriptionLv: null,
      price: "5.00",
      deposit: null,
      serviceDurationMinutes: null,
      sync: { status: "synced", syncedAt: "2026-11-06T10:00:00.000Z", problem: null },
    };
    expect(sellerAgentCatalogResult.safeParse({ products: [product], paypalSync: "synced" }).success).toBe(true);
    expect(sellerAgentCatalogResult.safeParse({ products: [{ ...product, paypalProductId: "provider-id" }], paypalSync: "synced" }).success).toBe(false);

    const row = {
      id: "5f4b2190-f88b-4d19-bef6-cc11e71bb6f1",
      position: 0,
      sourceRef: "row-1",
      status: "pending",
      title: null,
      kind: null,
      price: null,
      priceText: null,
      currency: null,
      serviceDurationMinutes: null,
      deposit: null,
      description: null,
      descriptionEn: null,
      descriptionLv: null,
      issues: [],
    };
    expect(sellerAgentReviewResult.safeParse({ importId: row.id, status: "needs_review", rows: [row], publishedProductIds: [], reviewUrl: "https://example.test/review" }).success).toBe(true);
    expect(sellerAgentReviewResult.safeParse({ importId: row.id, status: "needs_review", rows: [{ ...row, rawSource: "private provider payload" }], publishedProductIds: [], reviewUrl: "https://example.test/review" }).success).toBe(false);
  });
});
