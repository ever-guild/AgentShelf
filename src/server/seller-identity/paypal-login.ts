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

export class PayPalLoginError extends Error {
  constructor(readonly code: "MISCONFIGURED" | "UNAVAILABLE" | "INVALID_RESPONSE") {
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

function parseProfile(value: unknown): { subject: string; profile: PayPalLoginProfile } {
  const schema = z.object({
    sub: z.string().min(1).max(255).refine((value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value)),
    name: z.string().trim().max(160).optional(),
    given_name: z.string().trim().max(100).optional(),
    family_name: z.string().trim().max(100).optional(),
    email: z.email().max(320).optional(),
  });
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PayPalLoginError("INVALID_RESPONSE");
  const displayName = (parsed.data.name || [parsed.data.given_name, parsed.data.family_name].filter(Boolean).join(" ")).slice(0, 160);
  return {
    subject: parsed.data.sub,
    profile: { displayName: displayName || null, email: parsed.data.email ?? null },
  };
}

async function readJsonLimited(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new PayPalLoginError("INVALID_RESPONSE");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPONSE_LIMIT_BYTES) {
      await reader.cancel().catch(() => {});
      throw new PayPalLoginError("INVALID_RESPONSE");
    }
    chunks.push(value);
  }
  if (size === 0) throw new PayPalLoginError("INVALID_RESPONSE");
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size).toString("utf8")) as unknown;
  } catch {
    throw new PayPalLoginError("INVALID_RESPONSE");
  }
}

const tokenResponse = z.object({
  access_token: z.string().min(1).max(8192),
  token_type: z.string().regex(/^Bearer$/i),
  expires_in: z.coerce.number().int().positive(),
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
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url;
  }

  async function userInfo(code: string) {
    const clientId = required(env, "PAYPAL_LOGIN_CLIENT_ID");
    const clientSecret = required(env, "PAYPAL_LOGIN_CLIENT_SECRET");
    let tokenResponseValue: Response;
    try {
      tokenResponseValue = await fetchImpl(SANDBOX_TOKEN_URL, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({ grant_type: "authorization_code", code }),
      });
    } catch {
      throw new PayPalLoginError("UNAVAILABLE");
    }
    if (!tokenResponseValue.ok) throw new PayPalLoginError("UNAVAILABLE");
    const token = tokenResponse.safeParse(await readJsonLimited(tokenResponseValue));
    if (!token.success) throw new PayPalLoginError("INVALID_RESPONSE");

    let profileResponse: Response;
    try {
      profileResponse = await fetchImpl(SANDBOX_USERINFO_URL, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { authorization: `Bearer ${token.data.access_token}`, accept: "application/json" },
      });
    } catch {
      throw new PayPalLoginError("UNAVAILABLE");
    }
    if (!profileResponse.ok) throw new PayPalLoginError("UNAVAILABLE");
    return parseProfile(await readJsonLimited(profileResponse));
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
