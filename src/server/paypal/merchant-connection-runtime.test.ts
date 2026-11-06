import { describe, expect, it, vi } from "vitest";

import type { IdentityStore } from "../seller-identity/service";
import type { Pool } from "pg";
import { createMerchantConnectionHttpHandlers } from "./merchant-connection-http";
import { MERCHANT_CONNECTION_CALLBACK_PATH } from "./merchant-connection";
import { createMerchantConnectionRuntime } from "./merchant-connection-runtime";

const shopId = "5d1a0085-d25e-4d4d-872a-fb5ff80ad9a2";
const renderEnv = { RENDER_EXTERNAL_URL: "https://agentshelf.onrender.com" };
const configuredPayPalEnv = {
  PAYPAL_PLATFORM_CLIENT_ID: "test-platform-client",
  PAYPAL_PLATFORM_CLIENT_SECRET: "test-platform-secret",
  PAYPAL_PLATFORM_MERCHANT_ID: "test-platform-merchant",
  PAYPAL_PARTNER_ATTRIBUTION_ID: "test-partner-attribution",
};

function responseJson(value: unknown, status: number) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function harnessPool() {
  return { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as Pool;
}

function identityStore() {
  return { findOwnedShop: vi.fn(async () => ({ id: shopId })) } as unknown as IdentityStore;
}

describe("merchant connection runtime composition", () => {
  it("does not instantiate the HTTPS-only PayPal flow for unconfigured localhost HTTP", () => {
    const runtime = createMerchantConnectionRuntime({
      pool: {} as Pool,
      identityStore: {} as IdentityStore,
      env: { APP_ORIGIN: "http://localhost:3217" },
    });
    expect(runtime.platformConfigured).toBe(false);
    expect(runtime.service).toBeUndefined();
  });

  it("recognizes Node's bracketed IPv6 loopback hostname", () => {
    const runtime = createMerchantConnectionRuntime({
      pool: {} as Pool,
      identityStore: {} as IdentityStore,
      env: { APP_ORIGIN: "http://[::1]:3217" },
    });
    expect(runtime.platformConfigured).toBe(false);
    expect(runtime.service).toBeUndefined();
  });

  it("rejects an HTTP origin when platform credentials are configured", () => {
    expect(() => createMerchantConnectionRuntime({
      pool: {} as Pool,
      identityStore: {} as IdentityStore,
      env: {
        APP_ORIGIN: "http://localhost:3217",
        PAYPAL_PLATFORM_CLIENT_ID: "client",
        PAYPAL_PLATFORM_CLIENT_SECRET: "secret",
        PAYPAL_PLATFORM_MERCHANT_ID: "merchant",
        PAYPAL_PARTNER_ATTRIBUTION_ID: "partner",
      },
    })).toThrow("APP_ORIGIN must use HTTPS");
  });

  it("uses Render's HTTPS origin for owner status when APP_ORIGIN and PayPal keys are absent", async () => {
    const fetchImpl = vi.fn();
    const runtime = createMerchantConnectionRuntime({
      pool: harnessPool(),
      identityStore: identityStore(),
      env: renderEnv,
      fetchImpl,
    });
    expect(runtime.appOrigin).toBe(renderEnv.RENDER_EXTERNAL_URL);
    expect(runtime.platformConfigured).toBe(false);

    const handlers = createMerchantConnectionHttpHandlers({
      service: runtime.service,
      repository: runtime.repository,
      authenticateOwnerShop: async () => ({ actorId: "owner-id", shopId }),
      appOrigin: runtime.appOrigin,
      platformConfigured: runtime.platformConfigured,
      webhookConfigured: runtime.webhookConfigured,
    });
    const status = await handlers.status(new Request(`${runtime.appOrigin}/api/seller/paypal/connection?shopId=${shopId}`));
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      connection: { shopId, status: "not_connected" },
      configured: false,
      webhookConfigured: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes the validated Render origin to Partner Referrals and uses the actual callback route", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(responseJson({ access_token: "test-access-token", token_type: "Bearer", expires_in: 900 }, 200))
      .mockResolvedValueOnce(responseJson({
        links: [
          { rel: "self", href: "https://api-m.sandbox.paypal.com/v2/customer/partner-referrals/ref-test", method: "GET" },
          { rel: "action_url", href: "https://www.sandbox.paypal.com/us/merchantsignup/partner/onboardingentry?token=test-action-token", method: "GET" },
        ],
      }, 201));
    const runtime = createMerchantConnectionRuntime({
      pool: harnessPool(),
      identityStore: identityStore(),
      env: { ...renderEnv, ...configuredPayPalEnv },
      fetchImpl: fetchImpl as typeof fetch,
    });
    const returnUrl = new URL(MERCHANT_CONNECTION_CALLBACK_PATH, runtime.appOrigin).toString();

    await expect(runtime.paypal.createReferral({ trackingId: "a".repeat(43), returnUrl })).resolves.toMatchObject({
      referralUrl: "https://api-m.sandbox.paypal.com/v2/customer/partner-referrals/ref-test",
      actionUrl: "https://www.sandbox.paypal.com/us/merchantsignup/partner/onboardingentry?token=test-action-token",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect(fetchImpl.mock.calls[1][0]).toBe("https://api-m.sandbox.paypal.com/v2/customer/partner-referrals");
    const request = fetchImpl.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(request.body as string).partner_config_override.return_url).toBe(returnUrl);
  });

  it("preserves APP_ORIGIN precedence and rejects non-origin Render configuration", () => {
    const runtime = createMerchantConnectionRuntime({
      pool: harnessPool(),
      identityStore: identityStore(),
      env: { APP_ORIGIN: "https://custom.example", ...renderEnv },
    });
    expect(runtime.appOrigin).toBe("https://custom.example");

    for (const invalidOrigin of [
      "https://agentshelf.onrender.com/path",
      "https://agentshelf.onrender.com?query=1",
      "https://user:pass@agentshelf.onrender.com",
      "https://agentshelf.onrender.com#fragment",
    ]) {
      expect(() => createMerchantConnectionRuntime({
        pool: harnessPool(),
        identityStore: identityStore(),
        env: { RENDER_EXTERNAL_URL: invalidOrigin },
      })).toThrow("APP_ORIGIN must be an exact origin");
    }

    expect(() => createMerchantConnectionRuntime({
      pool: harnessPool(),
      identityStore: identityStore(),
      env: { APP_ORIGIN: "https://custom.example/path", ...renderEnv },
    })).toThrow("APP_ORIGIN must be an exact origin");
    expect(() => createMerchantConnectionRuntime({
      pool: harnessPool(),
      identityStore: identityStore(),
      env: { RENDER_EXTERNAL_URL: "http://remote.example" },
    })).toThrow("APP_ORIGIN must use HTTPS");
  });
});
