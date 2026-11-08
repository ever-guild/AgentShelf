import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import type { PayPalLoginProfile } from "../contracts/seller-identity";
import type { IdentityStore } from "./service";
import { issueOwnerSession } from "./service";

export const PAYPAL_LOGIN_CALLBACK_PATH = "/api/seller/identity/paypal/callback";
export const PAYPAL_LOGIN_STATE_COOKIE = "agentshelf_paypal_login_state";
export const PAYPAL_LOGIN_STATE_TTL_MS = 5 * 60_000;

const SANDBOX_CONNECT_URL = "https://www.sandbox.paypal.com/connect";
const SANDBOX_TOKEN_URL = "https://api-m.sandbox.paypal.com/v1/oauth2/token";
const SANDBOX_USERINFO_URL = "https://api-m.sandbox.paypal.com/v1/identity/openidconnect/userinfo?schema=openid";
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_LIMIT_BYTES = 32 * 1024;

type Environment = Record<string, string | undefined>;

export type PayPalLoginFailureStage =
  | "configuration"
  | "login_state"
  | "owner_read"
  | "token_exchange"
  | "token_response"
  | "refresh_exchange"
  | "refresh_response"
  | "userinfo_request"
  | "profile_validation"
  | "owner_session";

export type PayPalLoginFailureReason =
  | "misconfigured"
  | "persistence_failure"
  | "transport_error"
  | "http_error"
  | "invalid_json"
  | "invalid_response"
  | "missing_sub"
  | "invalid_subject"
  | "invalid_name"
  | "invalid_given_name"
  | "invalid_family_name"
  | "invalid_email"
  | "invalid_profile"
  | "unexpected_error";

export type PayPalLoginProviderErrorCode =
  | "invalid_grant"
  | "invalid_client"
  | "invalid_request"
  | "invalid_scope"
  | "invalid_token"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "access_denied"
  | "AUTHENTICATION_FAILURE"
  | "INVALID_CLIENT"
  | "INVALID_REQUEST"
  | "INVALID_TOKEN"
  | "NOT_AUTHORIZED"
  | "PERMISSION_DENIED";

export type PayPalLoginFailure = {
  stage: PayPalLoginFailureStage;
  reason: PayPalLoginFailureReason;
  httpStatus?: number;
  providerCode?: PayPalLoginProviderErrorCode;
};

const PROVIDER_ERROR_CODES = new Set<PayPalLoginProviderErrorCode>([
  "invalid_grant",
  "invalid_client",
  "invalid_request",
  "invalid_scope",
  "invalid_token",
  "unauthorized_client",
  "unsupported_grant_type",
  "access_denied",
  "AUTHENTICATION_FAILURE",
  "INVALID_CLIENT",
  "INVALID_REQUEST",
  "INVALID_TOKEN",
  "NOT_AUTHORIZED",
  "PERMISSION_DENIED",
]);

function providerErrorCode(value: unknown): PayPalLoginProviderErrorCode | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as { error?: unknown; name?: unknown };
  for (const candidate of [record.error, record.name]) {
    if (typeof candidate === "string" && PROVIDER_ERROR_CODES.has(candidate as PayPalLoginProviderErrorCode)) {
      return candidate as PayPalLoginProviderErrorCode;
    }
  }
  return undefined;
}

async function boundedProviderErrorCode(response: Response, stage: PayPalLoginFailureStage) {
  try {
    return providerErrorCode(await readJsonLimited(response, stage));
  } catch {
    return undefined;
  }
}

export class PayPalLoginError extends Error {
  constructor(
    readonly code: "MISCONFIGURED" | "UNAVAILABLE" | "INVALID_RESPONSE",
    readonly failure: PayPalLoginFailure = { stage: "configuration", reason: "misconfigured" },
  ) {
    super("PayPal sign-in could not be completed.");
    this.name = "PayPalLoginError";
  }
}

function required(env: Environment, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new PayPalLoginError("MISCONFIGURED");
  return value;
}

export function paypalLoginOrigin(env: Environment = process.env): URL {
  const configured = env.APP_ORIGIN || env.RENDER_EXTERNAL_URL;
  if (!configured) throw new PayPalLoginError("MISCONFIGURED");
  const text = configured.trim();
  let origin: URL;
  try {
    origin = new URL(text);
  } catch {
    throw new PayPalLoginError("MISCONFIGURED");
  }
  if (
    origin.origin !== text.replace(/\/$/, "") ||
    origin.username || origin.password || origin.search || origin.hash
  ) {
    throw new PayPalLoginError("MISCONFIGURED");
  }
  const hostname = origin.hostname.replace(/^\[|\]$/g, "");
  const localHttp = origin.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(hostname);
  if (origin.protocol !== "https:" && !localHttp) throw new PayPalLoginError("MISCONFIGURED");
  return origin;
}

export function paypalLoginCallbackUrl(env: Environment = process.env): string {
  return new URL(PAYPAL_LOGIN_CALLBACK_PATH, paypalLoginOrigin(env)).toString();
}

function optionalAddressText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function parseProfile(value: unknown, httpStatus: number): { subject: string; profile: PayPalLoginProfile } {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("sub" in value)) {
    throw new PayPalLoginError("INVALID_RESPONSE", { stage: "profile_validation", reason: "missing_sub", httpStatus });
  }
  const schema = z.object({
    sub: z.string().min(1).max(255).refine((value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value)),
    name: z.string().trim().max(160).optional(),
    given_name: z.string().trim().max(100).optional(),
    family_name: z.string().trim().max(100).optional(),
    email: z.email().max(320).optional(),
    // Address claims are optional and may vary by PayPal account. Their validation is deliberately
    // lenient below so malformed optional location data never prevents authentication.
    address: z.unknown().optional(),
  });
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const subject = (value as { sub?: unknown }).sub;
    const field = parsed.error.issues[0]?.path[0];
    const reason: PayPalLoginFailureReason = field === "sub"
      ? typeof subject === "string" && subject.trim().length > 0 ? "invalid_subject" : "missing_sub"
      : field === "name" ? "invalid_name"
        : field === "given_name" ? "invalid_given_name"
          : field === "family_name" ? "invalid_family_name"
            : field === "email" ? "invalid_email"
              : "invalid_profile";
    throw new PayPalLoginError("INVALID_RESPONSE", { stage: "profile_validation", reason, httpStatus });
  }
  const displayName = (parsed.data.name || [parsed.data.given_name, parsed.data.family_name].filter(Boolean).join(" ")).slice(0, 160);
  return {
    subject: parsed.data.sub,
    profile: {
      displayName: displayName || null,
      email: parsed.data.email ?? null,
      city: optionalAddressText(
        typeof parsed.data.address === "object" && parsed.data.address !== null && !Array.isArray(parsed.data.address)
          ? (parsed.data.address as { locality?: unknown }).locality
          : undefined,
        100,
      ),
      country: optionalAddressText(
        typeof parsed.data.address === "object" && parsed.data.address !== null && !Array.isArray(parsed.data.address)
          ? (parsed.data.address as { country?: unknown }).country
          : undefined,
        56,
      ),
    },
  };
}

async function readJsonLimited(
  response: Response,
  stage: PayPalLoginFailureStage,
): Promise<unknown> {
  const httpStatus = response.status;
  const reader = response.body?.getReader();
  if (!reader) throw new PayPalLoginError("INVALID_RESPONSE", { stage, reason: "invalid_response", httpStatus });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT_BYTES) {
        await reader.cancel().catch(() => {});
        throw new PayPalLoginError("INVALID_RESPONSE", { stage, reason: "invalid_response", httpStatus });
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof PayPalLoginError) throw error;
    throw new PayPalLoginError("INVALID_RESPONSE", { stage, reason: "invalid_response", httpStatus });
  }
  if (size === 0) throw new PayPalLoginError("INVALID_RESPONSE", { stage, reason: "invalid_response", httpStatus });
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size).toString("utf8")) as unknown;
  } catch {
    throw new PayPalLoginError("INVALID_RESPONSE", { stage, reason: "invalid_json", httpStatus });
  }
}

const accessTokenResponse = z.object({
  access_token: z.string().min(1).max(8192),
  token_type: z.string().regex(/^Bearer$/i),
  expires_in: z.coerce.number().int().positive(),
});

const authorizationCodeTokenResponse = accessTokenResponse.extend({
  refresh_token: z.string().min(1).max(8192),
});

/** Log in with PayPal uses its own Sandbox app credentials, separate from Partner Referrals. */
export function createPayPalLoginAdapter(
  env: Environment = process.env,
  fetchImpl: typeof fetch = fetch,
) {
  function assertConfigured() {
    required(env, "PAYPAL_LOGIN_CLIENT_ID");
    required(env, "PAYPAL_LOGIN_CLIENT_SECRET");
    paypalLoginCallbackUrl(env);
  }

  function authorizationUrl(state: string, redirectUri = paypalLoginCallbackUrl(env)): URL {
    const url = new URL(SANDBOX_CONNECT_URL);
    url.searchParams.set("flowEntry", "static");
    url.searchParams.set("client_id", required(env, "PAYPAL_LOGIN_CLIENT_ID"));
    required(env, "PAYPAL_LOGIN_CLIENT_SECRET");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid profile email address");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url;
  }

  async function userInfo(code: string) {
    const clientId = required(env, "PAYPAL_LOGIN_CLIENT_ID");
    const clientSecret = required(env, "PAYPAL_LOGIN_CLIENT_SECRET");
    const authorizationCodeTokenResponseValue = await exchangeToken({
      credentials: { clientId, clientSecret },
      grant: new URLSearchParams({ grant_type: "authorization_code", code }),
      exchangeStage: "token_exchange",
      responseStage: "token_response",
    });
    const authorizationToken = authorizationCodeTokenResponse.safeParse(authorizationCodeTokenResponseValue.body);
    if (!authorizationToken.success) {
      throw new PayPalLoginError("INVALID_RESPONSE", {
        stage: "token_response",
        reason: "invalid_response",
        httpStatus: authorizationCodeTokenResponseValue.httpStatus,
      });
    }

    // PayPal's Login guide instructs refreshing this code-exchange token before UserInfo:
    // https://developer.paypal.com/log-in/build/ (Get access token, step 3).
    const refreshedTokenResponseValue = await exchangeToken({
      credentials: { clientId, clientSecret },
      grant: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: authorizationToken.data.refresh_token,
      }),
      exchangeStage: "refresh_exchange",
      responseStage: "refresh_response",
    });
    const refreshedToken = accessTokenResponse.safeParse(refreshedTokenResponseValue.body);
    if (!refreshedToken.success) {
      throw new PayPalLoginError("INVALID_RESPONSE", {
        stage: "refresh_response",
        reason: "invalid_response",
        httpStatus: refreshedTokenResponseValue.httpStatus,
      });
    }

    let profileResponse: Response;
    try {
      profileResponse = await fetchImpl(SANDBOX_USERINFO_URL, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { authorization: `Bearer ${refreshedToken.data.access_token}`, accept: "application/json" },
      });
    } catch {
      throw new PayPalLoginError("UNAVAILABLE", { stage: "userinfo_request", reason: "transport_error" });
    }
    if (!profileResponse.ok) {
      throw new PayPalLoginError("UNAVAILABLE", {
        stage: "userinfo_request",
        reason: "http_error",
        httpStatus: profileResponse.status,
        providerCode: await boundedProviderErrorCode(profileResponse, "userinfo_request"),
      });
    }
    return parseProfile(await readJsonLimited(profileResponse, "profile_validation"), profileResponse.status);
  }

  async function exchangeToken(input: {
    credentials: { clientId: string; clientSecret: string };
    grant: URLSearchParams;
    exchangeStage: "token_exchange" | "refresh_exchange";
    responseStage: "token_response" | "refresh_response";
  }): Promise<{ body: unknown; httpStatus: number }> {
    let response: Response;
    try {
      response = await fetchImpl(SANDBOX_TOKEN_URL, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          authorization: `Basic ${Buffer.from(`${input.credentials.clientId}:${input.credentials.clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: input.grant,
      });
    } catch {
      throw new PayPalLoginError("UNAVAILABLE", { stage: input.exchangeStage, reason: "transport_error" });
    }
    if (!response.ok) {
      throw new PayPalLoginError("UNAVAILABLE", {
        stage: input.responseStage,
        reason: "http_error",
        httpStatus: response.status,
        providerCode: await boundedProviderErrorCode(response, input.responseStage),
      });
    }
    return { body: await readJsonLimited(response, input.responseStage), httpStatus: response.status };
  }

  return { assertConfigured, authorizationUrl, userInfo };
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function createPayPalLoginAttempt(store: IdentityStore, now = new Date()) {
  const state = randomBytes(32).toString("base64url");
  const browserBinding = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + PAYPAL_LOGIN_STATE_TTL_MS);
  await store.createPayPalLoginState({
    stateHash: hash(state),
    browserBindingHash: hash(browserBinding),
    expiresAt,
    now,
  });
  return { state, browserBinding, expiresAt };
}

export async function consumePayPalLoginAttempt(
  store: IdentityStore,
  state: string,
  browserBinding: string,
  now = new Date(),
): Promise<boolean> {
  return store.consumePayPalLoginState({
    stateHash: hash(state),
    browserBindingHash: hash(browserBinding),
    now,
  });
}

export async function authenticatePayPalOwner(
  store: IdentityStore,
  input: { subject: string; profile: PayPalLoginProfile },
  now = new Date(),
) {
  const subjectHash = hash(`paypal_sandbox:sub:${input.subject}`);
  const identity = await store.findOrCreatePayPalOwnerIdentityAtomic({
    subjectHash,
    syntheticUsername: `paypal_${subjectHash.slice(0, 57)}`,
    profile: input.profile,
    now,
  });
  const session = await issueOwnerSession(store, identity.owner.id, now);
  const authenticatedOwner = { ownerId: identity.owner.id, expiresAt: session.expiresAt };
  return {
    owner: { ...identity.owner, paypalProfile: identity.profile },
    shops: await store.listOwnerShops(authenticatedOwner.ownerId),
    created: identity.created,
    ...session,
  };
}
