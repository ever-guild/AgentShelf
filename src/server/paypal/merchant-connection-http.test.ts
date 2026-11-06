import { describe, expect, it, vi } from "vitest";

import type { MerchantConnectionRepository, MerchantConnectionService } from "./merchant-connection";
import { createMerchantConnectionHttpHandlers } from "./merchant-connection-http";

const shopId = "5d1a0085-d25e-4d4d-872a-fb5ff80ad9a2";
const trackingId = "a".repeat(43);
const principal = { actorId: "0a6513a0-60cb-43d0-9d72-c4b98d37a2c0", shopId };
const appOrigin = "https://agentshelf.example";

function harness(options: {
  platformConfigured?: boolean;
  webhookConfigured?: boolean;
  outcome?: "invalid" | "unavailable" | "unmatched" | "duplicate" | "revoked";
} = {}) {
  const service = {
    start: vi.fn(async () => ({ connection: { shopId, status: "pending" }, actionUrl: "https://www.sandbox.paypal.com/onboarding?token=hidden" })),
    get: vi.fn(async () => ({ shopId, status: "not_connected" })),
    refreshStatus: vi.fn(async () => ({ shopId, status: "pending" })),
    complete: vi.fn(async () => ({ shopId, status: "ready" })),
    handleRevocationWebhook: vi.fn(async () => ({ applied: options.outcome === "revoked", outcome: options.outcome ?? "revoked" })),
  } as unknown as MerchantConnectionService;
  const repository = {
    getByTrackingId: vi.fn(async (id: string) => id === trackingId ? { shopId, trackingId } : undefined),
  } as unknown as MerchantConnectionRepository;
  const authenticateOwnerShop = vi.fn(async (_request: Request, requestedShopId: string) => {
    if (requestedShopId !== shopId) throw new Error("wrong shop");
    return principal;
  });
  const handlers = createMerchantConnectionHttpHandlers({
    service,
    repository,
    authenticateOwnerShop,
    appOrigin,
    platformConfigured: options.platformConfigured ?? true,
    webhookConfigured: options.webhookConfigured ?? true,
  });
  return { handlers, service, repository, authenticateOwnerShop };
}

const ownerRequest = (path: string, init?: RequestInit) => new Request(`${appOrigin}${path}`, {
  ...init,
  headers: { origin: appOrigin, "content-type": "application/json", ...(init?.headers ?? {}) },
});

describe("PayPal merchant connection HTTP handlers", () => {
  it("requires explicit share-data consent and does not call service when consent is missing", async () => {
    const { handlers, service, authenticateOwnerShop } = harness();
    const response = await handlers.start(ownerRequest("/api/seller/paypal/connection", {
      method: "POST",
      body: JSON.stringify({ shopId, idempotencyKey: "client-request-key-0001", shareDataConsent: false }),
    }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "CONSENT_REQUIRED" } });
    expect(service.start).not.toHaveBeenCalled();
    expect(authenticateOwnerShop).not.toHaveBeenCalled();
  });

  it("returns the delegated PayPal action URL only after configured owner start", async () => {
    const { handlers, service, authenticateOwnerShop } = harness();
    const response = await handlers.start(ownerRequest("/api/seller/paypal/connection", {
      method: "POST",
      body: JSON.stringify({ shopId, idempotencyKey: "client-request-key-0001", shareDataConsent: true }),
    }));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ connection: { status: "pending" }, actionUrl: "https://www.sandbox.paypal.com/onboarding?token=hidden" });
    expect(service.start).toHaveBeenCalledWith(principal, { shopId, idempotencyKey: "client-request-key-0001", shareDataConsent: true });
    expect(authenticateOwnerShop).toHaveBeenCalledWith(expect.any(Request), shopId);
  });

  it("blocks start without platform config and rejects cross-origin mutations", async () => {
    const unconfigured = harness({ platformConfigured: false });
    const body = JSON.stringify({ shopId, idempotencyKey: "client-request-key-0001", shareDataConsent: true });
    const blocked = await unconfigured.handlers.start(ownerRequest("/api/seller/paypal/connection", { method: "POST", body }));
    expect(blocked.status).toBe(503);
    expect(unconfigured.service.start).not.toHaveBeenCalled();

    const response = await unconfigured.handlers.start(new Request(`${appOrigin}/api/seller/paypal/connection`, {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body,
    }));
    expect(response.status).toBe(403);
    expect(unconfigured.authenticateOwnerShop).not.toHaveBeenCalled();
  });

  it("returns status plus only configuration-presence booleans", async () => {
    const { handlers } = harness({ platformConfigured: true, webhookConfigured: false });
    const response = await handlers.status(new Request(`${appOrigin}/api/seller/paypal/connection?shopId=${shopId}`));
    expect(await response.json()).toEqual({
      connection: { shopId, status: "not_connected" },
      configured: true,
      webhookConfigured: false,
    });
  });

  it("authenticates the shop bound to PayPal tracking before processing callback hints", async () => {
    const { handlers, service, authenticateOwnerShop } = harness();
    const response = await handlers.callback(new Request(
      `${appOrigin}/api/seller/paypal/connection/callback?merchantId=${trackingId}&merchantIdInPayPal=sandboxSeller123&permissionsGranted=true`,
    ));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${appOrigin}/seller/paypal-connection?shopId=${shopId}&status=ready`);
    expect(authenticateOwnerShop).toHaveBeenCalledWith(expect.any(Request), shopId);
    expect(service.complete).toHaveBeenCalledWith(principal, { trackingId, sellerMerchantIdHint: "sandboxSeller123" });
  });

  it("retries revocation verification on provider outage and acknowledges invalid/handled events safely", async () => {
    const unavailable = harness({ outcome: "unavailable" });
    const request = new Request(`${appOrigin}/api/paypal/platform-webhooks`, { method: "POST", body: "{}" });
    expect((await unavailable.handlers.revocationWebhook(request)).status).toBe(503);

    const invalid = harness({ outcome: "invalid" });
    expect((await invalid.handlers.revocationWebhook(new Request(`${appOrigin}/api/paypal/platform-webhooks`, { method: "POST", body: "{}" }))).status).toBe(400);

    const applied = harness({ outcome: "revoked" });
    expect((await applied.handlers.revocationWebhook(new Request(`${appOrigin}/api/paypal/platform-webhooks`, { method: "POST", body: "{}" }))).status).toBe(204);
  });
});
