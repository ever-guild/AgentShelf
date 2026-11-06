import { describe, expect, it, vi } from "vitest";
import {
  inspectPlatformConfiguration,
  runPlatformPreflight,
  SANDBOX_ORIGIN,
  TOKEN_URL,
} from "../../scripts/paypal-platform-preflight.mjs";

const env = {
  NODE_ENV: "test" as const,
  PAYPAL_PLATFORM_CLIENT_ID: "platform-client-id",
  PAYPAL_PLATFORM_CLIENT_SECRET: "platform-client-secret",
  PAYPAL_PLATFORM_MERCHANT_ID: "platform-merchant-id",
  PAYPAL_PARTNER_ATTRIBUTION_ID: "platform-bn-code",
};
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("PayPal platform preflight", () => {
  it("checks names only and makes no network request offline", async () => {
    expect(inspectPlatformConfiguration({ ...env, PAYPAL_PLATFORM_CLIENT_SECRET: " " })).toContain("PAYPAL_PLATFORM_CLIENT_SECRET");
    const fetchImpl = vi.fn();
    const log = vi.fn();
    await expect(runPlatformPreflight({ env: { ...env }, fetchImpl, log })).resolves.toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(" ")).not.toContain(env.PAYPAL_PLATFORM_CLIENT_SECRET);
  });

  it("performs only sandbox OAuth when explicitly online without seller status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ access_token: "hidden-token", token_type: "Bearer" }));
    const log = vi.fn();
    await expect(runPlatformPreflight({ env, online: true, fetchImpl, log })).resolves.toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(TOKEN_URL);
    expect(new URL(TOKEN_URL).origin).toBe(SANDBOX_ORIGIN);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error", body: "grant_type=client_credentials" });
    expect(log.mock.calls.flat().join(" ")).not.toContain("hidden-token");
    expect(log.mock.calls.flat().join(" ")).not.toContain(env.PAYPAL_PLATFORM_CLIENT_SECRET);
  });

  it("uses only the documented fixed sandbox status GET with platform attribution", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok({ access_token: "hidden-token", token_type: "Bearer" }))
      .mockResolvedValueOnce(ok({
        merchant_id: "seller-id-123",
        payments_receivable: true,
        primary_email_confirmed: true,
        products: [{ name: "EXPRESS_CHECKOUT", status: "ACTIVE" }],
        oauth_integrations: [{
          integration_type: "OAUTH_THIRD_PARTY",
          integration_method: "PAYPAL",
          oauth_third_party: [{ scopes: ["https://uri.paypal.com/services/payments/payment/authcapture"] }],
        }],
      }));
    const log = vi.fn();
    await expect(runPlatformPreflight({ env, online: true, sellerId: "seller-id-123", fetchImpl, log })).resolves.toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, request] = fetchImpl.mock.calls[1];
    expect(url).toBe(`${SANDBOX_ORIGIN}/v1/customer/partners/platform-merchant-id/merchant-integrations/seller-id-123`);
    expect(request).toMatchObject({ method: "GET", redirect: "error" });
    const headers = request.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer hidden-token");
    expect(headers["PayPal-Partner-Attribution-Id"]).toBe(env.PAYPAL_PARTNER_ATTRIBUTION_ID);
    expect(headers["PayPal-Auth-Assertion"]).toBeUndefined();
    expect(log.mock.calls.flat().join(" ")).not.toContain("hidden-token");
  });

  it("blocks an incomplete seller even when the status API returns HTTP 200", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok({ access_token: "hidden-token", token_type: "Bearer" }))
      .mockResolvedValueOnce(ok({ payments_receivable: false, primary_email_confirmed: false }));
    const log = vi.fn();
    await expect(runPlatformPreflight({ env, online: true, sellerId: "seller-id-123", fetchImpl, log })).resolves.toBe(1);
    expect(log.mock.calls.flat().join(" ")).toContain("BLOCKED seller integration status");
  });

  it("blocks a mismatched merchant and never logs a large response body", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok({ access_token: "hidden-token", token_type: "Bearer" }))
      .mockResolvedValueOnce(ok({
        merchant_id: "another-seller-id",
        payments_receivable: true,
        primary_email_confirmed: true,
        products: [{ name: "EXPRESS_CHECKOUT", status: "ACTIVE" }],
        oauth_integrations: [{ oauth_third_party: [{ scopes: ["https://uri.paypal.com/services/payments/payment/authcapture"] }] }],
        private_note: "should not be output",
      }));
    const log = vi.fn();
    await expect(runPlatformPreflight({ env, online: true, sellerId: "seller-id-123", fetchImpl, log })).resolves.toBe(1);
    const output = log.mock.calls.flat().join(" ");
    expect(output).toContain("merchant matches false");
    expect(output).not.toContain("another-seller-id");
    expect(output).not.toContain("should not be output");

    const oversized = vi.fn().mockResolvedValueOnce(ok({ access_token: "hidden-token", token_type: "Bearer" })).mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "hidden-token", token_type: "Bearer" }) + " ".repeat(129 * 1024), { status: 200 }),
    );
    await expect(runPlatformPreflight({ env, online: true, sellerId: "seller-id-123", fetchImpl: oversized, log })).resolves.toBe(1);
    expect(log.mock.calls.flat().join(" ")).not.toContain("hidden-token");
  });

  it("rejects malformed seller IDs before requests and sanitizes failures", async () => {
    const fetchImpl = vi.fn();
    const log = vi.fn();
    await expect(runPlatformPreflight({ env, online: true, sellerId: "https://evil.example", fetchImpl, log })).resolves.toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();

    fetchImpl.mockResolvedValueOnce(new Response("contains platform-client-secret", { status: 401 }));
    await expect(runPlatformPreflight({ env, online: true, fetchImpl, log })).resolves.toBe(1);
    const output = log.mock.calls.flat().join(" ");
    expect(output).toContain("OAuth HTTP 401");
    expect(output).not.toContain("contains platform-client-secret");
    expect(output).not.toContain(env.PAYPAL_PLATFORM_CLIENT_SECRET);
  });
});
