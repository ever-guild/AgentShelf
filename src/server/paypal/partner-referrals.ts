import { z } from "zod";

import {
  PartnerReferralsRequestError,
  type MerchantStatusEvidence,
  type PartnerReferralsAdapter,
} from "./merchant-connection";

const API_ORIGIN = "https://api-m.sandbox.paypal.com";
const ACTION_ORIGIN = "https://www.sandbox.paypal.com";
const TOKEN_URL = `${API_ORIGIN}/v1/oauth2/token`;
const TOKEN_TIMEOUT_MS = 12_000;
const REFERRAL_TIMEOUT_MS = 15_000;

const oauthResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().regex(/^Bearer$/i),
  expires_in: z.number().int().positive(),
});
const linksResponse = z.object({
  links: z.array(z.object({ rel: z.string(), href: z.string().url(), method: z.string().optional() })),
});
const merchantStatusResponse = z.object({
  merchant_id: z.string().min(3),
  tracking_id: z.string().min(1),
  payments_receivable: z.boolean(),
  primary_email_confirmed: z.boolean(),
  products: z.array(z.object({ name: z.string(), status: z.string().optional() })).optional(),
  oauth_integrations: z.array(z.object({
    integration_type: z.string(),
    integration_method: z.string(),
    oauth_third_party: z.array(z.object({ scopes: z.array(z.string()) })).optional(),
  })).optional(),
});
export class PayPalAdapterError extends Error {
  constructor(readonly code: "MISCONFIGURED" | "UNAVAILABLE" | "INVALID_RESPONSE") {
    super("PayPal platform API request failed");
    this.name = "PayPalAdapterError";
  }
}

type Environment = Record<string, string | undefined>;
export type VerifiedMerchantRevocation = { eventId: string; eventType: string; sellerMerchantId: string };
export type MerchantRevocationWebhookVerifier = (input: { headers: Headers; rawBody: string }) => Promise<VerifiedMerchantRevocation | undefined>;

function required(env: Environment, key: string) {
  const value = env[key]?.trim();
  if (!value) throw new PayPalAdapterError("MISCONFIGURED");
  return value;
}

function validateOriginUrl(value: string, expectedOrigin: string, pathPattern: RegExp): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PayPalAdapterError("INVALID_RESPONSE");
  }
  if (
    url.origin !== expectedOrigin ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !pathPattern.test(url.pathname)
  ) {
    throw new PayPalAdapterError("INVALID_RESPONSE");
  }
  return url;
}

function referralApiUrl(value: string) {
  const url = validateOriginUrl(value, API_ORIGIN, /^\/v2\/customer\/partner-referrals\/[A-Za-z0-9_%+=/-]+$/);
  if (url.search) throw new PayPalAdapterError("INVALID_RESPONSE");
  return url.toString();
}

function actionUrl(value: string) {
  const url = validateOriginUrl(
    value,
    ACTION_ORIGIN,
    /^\/(?:[a-z]{2}\/)?merchantsignup\/partner\/onboardingentry$/i,
  );
  if (!url.searchParams.get("token")) throw new PayPalAdapterError("INVALID_RESPONSE");
  return url.toString();
}

function linksFrom(payload: unknown) {
  const parsed = linksResponse.safeParse(payload);
  if (!parsed.success) throw new PayPalAdapterError("INVALID_RESPONSE");
  const self = parsed.data.links.find((link) => link.rel === "self" && (!link.method || link.method === "GET"));
  const action = parsed.data.links.find((link) => link.rel === "action_url" && (!link.method || link.method === "GET"));
  if (!self || !action) throw new PayPalAdapterError("INVALID_RESPONSE");
  return { referralUrl: referralApiUrl(self.href), actionUrl: actionUrl(action.href) };
}

async function readJsonLimited(response: Response, limitBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new PayPalAdapterError("INVALID_RESPONSE");
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limitBytes) {
      await reader.cancel().catch(() => {});
      throw new PayPalAdapterError("INVALID_RESPONSE");
    }
    chunks.push(Buffer.from(value));
  }
  if (size === 0) throw new PayPalAdapterError("INVALID_RESPONSE");
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
  } catch {
    throw new PayPalAdapterError("INVALID_RESPONSE");
  }
}

/** Fixed-Sandbox adapter for Partner Referrals and seller integration status. */
export function createPartnerReferralsAdapter(
  env: Environment = process.env,
  fetchImpl: typeof fetch = fetch,
  verifyWebhook?: MerchantRevocationWebhookVerifier,
): PartnerReferralsAdapter {
  let cachedToken: { value: string; expiresAt: number } | undefined;

  async function accessToken() {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
    const clientId = required(env, "PAYPAL_PLATFORM_CLIENT_ID");
    const clientSecret = required(env, "PAYPAL_PLATFORM_CLIENT_SECRET");
    let response: Response;
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        headers: {
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: "grant_type=client_credentials",
      });
    } catch {
      throw new PayPalAdapterError("UNAVAILABLE");
    }
    if (!response.ok) throw new PayPalAdapterError(response.status >= 500 ? "UNAVAILABLE" : "MISCONFIGURED");
    const payload = oauthResponse.safeParse(await readJsonLimited(response, 16 * 1024));
    if (!payload.success) throw new PayPalAdapterError("INVALID_RESPONSE");
    cachedToken = {
      value: payload.data.access_token,
      expiresAt: Date.now() + payload.data.expires_in * 1_000,
    };
    return cachedToken.value;
  }

  async function callApi(url: string, init: RequestInit, kind: "create" | "read"): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(REFERRAL_TIMEOUT_MS),
      });
    } catch {
      if (kind === "create") throw new PartnerReferralsRequestError("unknown");
      throw new PayPalAdapterError("UNAVAILABLE");
    }
    if (!response.ok) {
      if (kind === "create") {
        throw new PartnerReferralsRequestError(response.status >= 500 ? "unknown" : "rejected");
      }
      throw new PayPalAdapterError(response.status >= 500 ? "UNAVAILABLE" : "MISCONFIGURED");
    }
    try {
      return await readJsonLimited(response, 128 * 1024);
    } catch {
      if (kind === "create") throw new PartnerReferralsRequestError("unknown");
      throw new PayPalAdapterError("INVALID_RESPONSE");
    }
  }

  async function baseHeaders() {
    return {
      authorization: `Bearer ${await accessToken()}`,
      "PayPal-Partner-Attribution-Id": required(env, "PAYPAL_PARTNER_ATTRIBUTION_ID"),
      accept: "application/json",
    };
  }

  return {
    async createReferral({ trackingId, returnUrl }) {
      const appOriginText = required(env, "APP_ORIGIN");
      let appOrigin: URL;
      try {
        appOrigin = new URL(appOriginText);
      } catch {
        throw new PartnerReferralsRequestError("rejected");
      }
      if (appOrigin.protocol !== "https:" || appOrigin.origin !== appOriginText.replace(/\/$/, "") || appOrigin.username || appOrigin.password) {
        throw new PartnerReferralsRequestError("rejected");
      }
      const callback = validateOriginUrl(returnUrl, appOrigin.origin, /^\/seller\/paypal\/callback$/);
      if (callback.search || callback.hash) throw new PartnerReferralsRequestError("rejected");
      const body = {
        tracking_id: trackingId,
        partner_config_override: {
          return_url: callback.toString(),
          return_url_description: "Return to AgentShelf after PayPal seller consent",
        },
        operations: [{
          operation: "API_INTEGRATION",
          api_integration_preference: {
            rest_api_integration: {
              integration_method: "PAYPAL",
              integration_type: "THIRD_PARTY",
              third_party_details: { features: ["PAYMENT"] },
            },
          },
        }],
        products: ["EXPRESS_CHECKOUT"],
        legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
      };
      let headers: Record<string, string>;
      try {
        headers = await baseHeaders();
      } catch {
        // OAuth failed before the referral POST was sent, so no referral was created.
        throw new PartnerReferralsRequestError("rejected");
      }
      const payload = await callApi(`${API_ORIGIN}/v2/customer/partner-referrals`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      }, "create");
      try {
        return linksFrom(payload);
      } catch {
        // A 2xx means PayPal may have created the referral. Never permit an automatic POST retry.
        throw new PartnerReferralsRequestError("unknown");
      }
    },

    async refreshReferral(referralUrl) {
      const url = referralApiUrl(referralUrl);
      const payload = await callApi(url, { method: "GET", headers: await baseHeaders() }, "read");
      return { actionUrl: linksFrom(payload).actionUrl };
    },

    async getMerchantStatus(sellerMerchantId) {
      if (!/^[A-Za-z0-9_-]{3,128}$/.test(sellerMerchantId)) throw new PayPalAdapterError("INVALID_RESPONSE");
      const partnerId = required(env, "PAYPAL_PLATFORM_MERCHANT_ID");
      const url = `${API_ORIGIN}/v1/customer/partners/${encodeURIComponent(partnerId)}/merchant-integrations/${encodeURIComponent(sellerMerchantId)}`;
      const payload = await callApi(url, { method: "GET", headers: await baseHeaders() }, "read");
      const parsed = merchantStatusResponse.safeParse(payload);
      if (!parsed.success) throw new PayPalAdapterError("INVALID_RESPONSE");
      const integrations = (parsed.data.oauth_integrations ?? []).filter(
        (entry) => entry.integration_type === "OAUTH_THIRD_PARTY" && entry.integration_method === "PAYPAL",
      );
      const scopes = [...new Set(integrations.flatMap((entry) => entry.oauth_third_party?.flatMap((grant) => grant.scopes) ?? []))];
      const evidence: MerchantStatusEvidence = {
        merchantId: parsed.data.merchant_id,
        trackingId: parsed.data.tracking_id,
        paymentsReceivable: parsed.data.payments_receivable,
        primaryEmailConfirmed: parsed.data.primary_email_confirmed,
        consentGranted: scopes.length > 0,
        activeProducts: (parsed.data.products ?? []).filter((product) => product.status === "ACTIVE").map((product) => product.name),
        grantedScopes: scopes,
      };
      return evidence;
    },

    async verifyRevocationWebhook({ headers, rawBody }) {
      if (!verifyWebhook) return undefined;
      let verified: VerifiedMerchantRevocation | undefined;
      try {
        verified = await verifyWebhook({ headers, rawBody });
      } catch {
        return undefined;
      }
      if (
        !verified ||
        verified.eventType !== "MERCHANT.PARTNER-CONSENT.REVOKED" ||
        !verified.eventId ||
        !/^[A-Za-z0-9_-]{3,128}$/.test(verified.sellerMerchantId)
      ) return undefined;
      return {
        eventId: verified.eventId,
        eventType: "MERCHANT.PARTNER-CONSENT.REVOKED",
        sellerMerchantId: verified.sellerMerchantId,
      };
    },
  };
}
