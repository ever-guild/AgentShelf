import { describe, expect, it, vi } from "vitest";

import { createPartnerReferralsAdapter, PayPalAdapterError } from "./partner-referrals";
import { MERCHANT_CONNECTION_CALLBACK_PATH } from "./merchant-connection";

const env = {
  APP_ORIGIN: "https://agentshelf.example",
  PAYPAL_PLATFORM_CLIENT_ID: "platform-client-id",
  PAYPAL_PLATFORM_CLIENT_SECRET: "platform-client-secret",
  PAYPAL_PLATFORM_MERCHANT_ID: "platform-merchant-id",
  PAYPAL_PARTNER_ATTRIBUTION_ID: "platform-bn-code",
};
const token = () => new Response(JSON.stringify({ access_token: "hidden-access-token", token_type: "Bearer", expires_in: 900 }), { status: 200 });
const referral = (
  action = "https://www.sandbox.paypal.com/us/merchantsignup/partner/onboardingentry?token=hidden",
  self = "https://api-m.sandbox.paypal.com/v2/customer/partner-referrals/ref-123",
) => new Response(JSON.stringify({
  links: [
    { rel: "self", href: self, method: "GET" },
    { rel: "action_url", href: action, method: "GET" },
  ],
}), { status: 201 });

describe("PayPal Partner Referrals adapter", () => {
  it("creates a fixed Sandbox referral with tracking and minimal payment consent", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(referral());
    const adapter = createPartnerReferralsAdapter(env, fetchImpl);
    const result = await adapter.createReferral({
      trackingId: "a".repeat(43),
      returnUrl: `https://agentshelf.example${MERCHANT_CONNECTION_CALLBACK_PATH}`,
    });
    expect(result).toEqual({
      referralUrl: "https://api-m.sandbox.paypal.com/v2/customer/partner-referrals/ref-123",
      actionUrl: "https://www.sandbox.paypal.com/us/merchantsignup/partner/onboardingentry?token=hidden",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [oauthUrl, oauth] = fetchImpl.mock.calls[0];
    expect(oauthUrl).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect(oauth).toMatchObject({ method: "POST", redirect: "error", body: "grant_type=client_credentials" });
    const [createUrl, create] = fetchImpl.mock.calls[1];
    expect(createUrl).toBe("https://api-m.sandbox.paypal.com/v2/customer/partner-referrals");
    expect(create).toMatchObject({ method: "POST", redirect: "error" });
    const headers = create.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer hidden-access-token");
    expect(headers["PayPal-Partner-Attribution-Id"]).toBe(env.PAYPAL_PARTNER_ATTRIBUTION_ID);
    expect(headers["PayPal-Request-Id"]).toBeUndefined();
    const body = JSON.parse(create.body as string);
    expect(body).toMatchObject({
      tracking_id: "a".repeat(43),
      partner_config_override: { return_url: `https://agentshelf.example${MERCHANT_CONNECTION_CALLBACK_PATH}` },
      products: ["EXPRESS_CHECKOUT"],
      operations: [{ api_integration_preference: { rest_api_integration: { third_party_details: { features: ["PAYMENT"] } } } }],
      legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
    });
  });

  it("accepts PayPal's documented sandbox api alias and bizsignup referral link", async () => {
    const action = "https://api.sandbox.paypal.com/bizsignup/partner/entry?referralToken=one-time-referral-token";
    const self = "https://api.sandbox.paypal.com/v2/customer/partner-referrals/referral-id";
    const fetchImpl = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(referral(action, self));
    const adapter = createPartnerReferralsAdapter(env, fetchImpl);

    await expect(adapter.createReferral({
      trackingId: "b".repeat(43),
      returnUrl: `https://agentshelf.example${MERCHANT_CONNECTION_CALLBACK_PATH}`,
    })).resolves.toEqual({ referralUrl: self, actionUrl: action });
  });

  it("accepts the documented api-m sandbox bizsignup variant", async () => {
    const action = "https://api-m.sandbox.paypal.com/bizsignup/partner/entry?referralToken=one-time-referral-token";
    const fetchImpl = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(referral(action));
    const adapter = createPartnerReferralsAdapter(env, fetchImpl);

    await expect(adapter.createReferral({
      trackingId: "f".repeat(43),
      returnUrl: `https://agentshelf.example${MERCHANT_CONNECTION_CALLBACK_PATH}`,
    })).resolves.toMatchObject({ actionUrl: action });
  });

  it("accepts the observed www sandbox bizsignup link and requires its matching token key", async () => {
    const action = "https://www.sandbox.paypal.com/bizsignup/partner/entry?referralToken=one-time-referral-token";
    const self = "https://api.sandbox.paypal.com/v2/customer/partner-referrals/referral-id";
    const fetchImpl = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(referral(action, self));
    const adapter = createPartnerReferralsAdapter(env, fetchImpl);

    await expect(adapter.createReferral({
      trackingId: "d".repeat(43),
      returnUrl: `https://agentshelf.example${MERCHANT_CONNECTION_CALLBACK_PATH}`,
    })).resolves.toEqual({ referralUrl: self, actionUrl: action });

    const mismatchedKey = createPartnerReferralsAdapter(env, vi.fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(referral("https://www.sandbox.paypal.com/bizsignup/partner/entry?token=wrong-key")));
    await expect(mismatchedKey.createReferral({
      trackingId: "e".repeat(43),
      returnUrl: `https://agentshelf.example${MERCHANT_CONNECTION_CALLBACK_PATH}`,
    })).rejects.toMatchObject({ outcome: "unknown" });

    const lookalikeHost = createPartnerReferralsAdapter(env, vi.fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(referral("https://api-m.sandbox.paypal.com.attacker.example/bizsignup/partner/entry?referralToken=wrong-host")));
    await expect(lookalikeHost.createReferral({
      trackingId: "g".repeat(43),
      returnUrl: `https://agentshelf.example${MERCHANT_CONNECTION_CALLBACK_PATH}`,
    })).rejects.toMatchObject({ outcome: "unknown" });
  });

  it("keeps referral failure diagnostics stage-safe when a successful response has unusable links", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const trackingId = "c".repeat(43);
    const secretAction = "https://attacker.example/leak?token=diagnostic-action-secret";
    const fetchImpl = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(referral(secretAction));
    const adapter = createPartnerReferralsAdapter(env, fetchImpl);

    try {
      await expect(adapter.createReferral({
        trackingId,
        returnUrl: `https://agentshelf.example${MERCHANT_CONNECTION_CALLBACK_PATH}`,
      })).rejects.toMatchObject({ outcome: "unknown" });

      expect(warning).toHaveBeenCalledTimes(1);
      const event = String(warning.mock.calls[0][0]);
      expect(JSON.parse(event)).toEqual({
        event: "paypal_partner_referral_failure",
        stage: "referral_links",
        reason: "invalid_links",
      });
      expect(event).not.toContain("attacker.example");
      expect(event).not.toContain("diagnostic-action-secret");
      expect(event).not.toContain(trackingId);
    } finally {
      warning.mockRestore();
    }
  });

  it("validates a merchant only against the platform status response", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        merchant_id: "sellerMerchantA123",
        tracking_id: "a".repeat(43),
        payments_receivable: true,
        primary_email_confirmed: true,
        products: [{ name: "EXPRESS_CHECKOUT", status: "ACTIVE" }],
        oauth_integrations: [{
          integration_type: "OAUTH_THIRD_PARTY",
          integration_method: "PAYPAL",
          oauth_third_party: [{ scopes: ["https://uri.paypal.com/services/payments/payment/authcapture"] }],
        }],
      }), { status: 200 }));
    const adapter = createPartnerReferralsAdapter(env, fetchImpl);
    await expect(adapter.getMerchantStatus("sellerMerchantA123")).resolves.toMatchObject({
      merchantId: "sellerMerchantA123",
      trackingId: "a".repeat(43),
      paymentsReceivable: true,
      primaryEmailConfirmed: true,
      consentGranted: true,
      activeProducts: ["EXPRESS_CHECKOUT"],
      grantedScopes: ["https://uri.paypal.com/services/payments/payment/authcapture"],
    });
    const [url, request] = fetchImpl.mock.calls[1];
    expect(url).toBe("https://api-m.sandbox.paypal.com/v1/customer/partners/platform-merchant-id/merchant-integrations/sellerMerchantA123");
    expect(request.method).toBe("GET");
    expect((request.headers as Record<string, string>)["PayPal-Auth-Assertion"]).toBeUndefined();
  });

  it("rejects foreign PayPal action URLs and classifies a 2xx unusable response as ambiguous", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(referral("https://attacker.example/collect?token=hidden"));
    const adapter = createPartnerReferralsAdapter(env, fetchImpl);
    await expect(adapter.createReferral({ trackingId: "a".repeat(43), returnUrl: `https://agentshelf.example${MERCHANT_CONNECTION_CALLBACK_PATH}` }))
      .rejects.toMatchObject({ outcome: "unknown" });
    expect(fetchImpl.mock.calls[1][1].method).toBe("POST");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("requires an action token and bounds the referral response body", async () => {
    const missingToken = createPartnerReferralsAdapter(env, vi.fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(referral("https://www.sandbox.paypal.com/us/merchantsignup/partner/onboardingentry")));
    await expect(missingToken.createReferral({
      trackingId: "a".repeat(43),
      returnUrl: `https://agentshelf.example${MERCHANT_CONNECTION_CALLBACK_PATH}`,
    })).rejects.toMatchObject({ outcome: "unknown" });

    const oversized = createPartnerReferralsAdapter(env, vi.fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(new Response("{" + " ".repeat(128 * 1024) + "}", { status: 201 })));
    await expect(oversized.createReferral({
      trackingId: "a".repeat(43),
      returnUrl: `https://agentshelf.example${MERCHANT_CONNECTION_CALLBACK_PATH}`,
    })).rejects.toMatchObject({ outcome: "unknown" });
  });

  it("rejects a return URL on another host before sending a referral", async () => {
    const fetchImpl = vi.fn();
    const adapter = createPartnerReferralsAdapter(env, fetchImpl);
    await expect(adapter.createReferral({ trackingId: "a".repeat(43), returnUrl: `https://attacker.example${MERCHANT_CONNECTION_CALLBACK_PATH}` }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an obsolete callback path before sending a referral", async () => {
    const fetchImpl = vi.fn();
    const adapter = createPartnerReferralsAdapter(env, fetchImpl);
    await expect(adapter.createReferral({ trackingId: "a".repeat(43), returnUrl: "https://agentshelf.example/seller/paypal/callback" }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("applies only signature-verified consent revocation webhook events", async () => {
    const verifier = vi.fn(async (): Promise<{ eventId: string; eventType: string; sellerMerchantId: string } | undefined> => ({
      eventId: "event-123",
      eventType: "MERCHANT.PARTNER-CONSENT.REVOKED",
      sellerMerchantId: "sellerMerchantA123",
    }));
    const adapter = createPartnerReferralsAdapter(env, fetch, verifier);
    const body = JSON.stringify({ id: "event-123", event_type: "MERCHANT.PARTNER-CONSENT.REVOKED", resource: { merchant_id: "sellerMerchantA123" } });
    await expect(adapter.verifyRevocationWebhook({ headers: new Headers(), rawBody: body })).resolves.toEqual({
      eventId: "event-123",
      eventType: "MERCHANT.PARTNER-CONSENT.REVOKED",
      sellerMerchantId: "sellerMerchantA123",
    });
    verifier.mockResolvedValueOnce(undefined);
    await expect(adapter.verifyRevocationWebhook({ headers: new Headers(), rawBody: body })).resolves.toBeUndefined();
    expect(verifier).toHaveBeenCalledTimes(2);
  });

  it("verifies the raw revocation event through PayPal's fixed Sandbox verification endpoint", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(new Response(JSON.stringify({ verification_status: "SUCCESS" }), { status: 200 }));
    const adapter = createPartnerReferralsAdapter({ ...env, PAYPAL_PLATFORM_WEBHOOK_ID: "sandbox-webhook-123" }, fetchImpl);
    const headers = new Headers({
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-123",
      "paypal-transmission-id": "transmission-123",
      "paypal-transmission-sig": "signature-base64",
      "paypal-transmission-time": "2026-11-06T12:00:00Z",
    });
    const event = {
      id: "event-123",
      event_type: "MERCHANT.PARTNER-CONSENT.REVOKED",
      resource: { merchant_id: "sellerMerchantA123" },
    };
    await expect(adapter.verifyRevocationWebhook({ headers, rawBody: JSON.stringify(event) })).resolves.toEqual({
      eventId: "event-123",
      eventType: "MERCHANT.PARTNER-CONSENT.REVOKED",
      sellerMerchantId: "sellerMerchantA123",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, request] = fetchImpl.mock.calls[1];
    expect(url).toBe("https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature");
    expect(request).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(request.body as string)).toMatchObject({
      webhook_id: "sandbox-webhook-123",
      webhook_event: event,
      auth_algo: "SHA256withRSA",
    });
  });

  it("sanitizes failed Sandbox OAuth and invalid seller IDs", async () => {
    const oauthFailure = createPartnerReferralsAdapter(env, vi.fn().mockResolvedValue(new Response("sensitive diagnostic", { status: 401 })));
    await expect(oauthFailure.getMerchantStatus("sellerMerchantA123")).rejects.toBeInstanceOf(PayPalAdapterError);
    const noCalls = vi.fn();
    const adapter = createPartnerReferralsAdapter(env, noCalls);
    await expect(adapter.getMerchantStatus("https://attacker.example")).rejects.toBeInstanceOf(PayPalAdapterError);
    expect(noCalls).not.toHaveBeenCalled();
  });
});
