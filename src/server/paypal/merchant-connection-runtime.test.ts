import { describe, expect, it } from "vitest";

import type { IdentityStore } from "../seller-identity/service";
import type { Pool } from "pg";
import { createMerchantConnectionRuntime } from "./merchant-connection-runtime";

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
});
