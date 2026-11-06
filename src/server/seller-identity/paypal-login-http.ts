import "server-only";

import { isIP } from "node:net";
import type { AttemptLimiter, IdentityStore } from "./service";
import {
  authenticatePayPalOwner,
  consumePayPalLoginAttempt,
  createPayPalLoginAdapter,
  createPayPalLoginAttempt,
  PAYPAL_LOGIN_CALLBACK_PATH,
  PAYPAL_LOGIN_STATE_COOKIE,
  paypalLoginCallbackUrl,
  paypalLoginOrigin,
} from "./paypal-login";
import {
  clearLegacySellerSessionCookie,
  clearOwnerCookies,
  clearSelectedOwnerShopCookie,
  ownerCookieValue,
  OWNER_SESSION_COOKIE,
  ownerSessionCookie,
} from "./http-auth";
import { IdentityError, requireOwnerSession } from "./service";
import { callerOf } from "../mcp/caller-limits";

type Environment = Record<string, string | undefined>;
const STATE_COOKIE_TTL_SECONDS = 5 * 60;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOGIN_ERROR_CODES = new Set([
  "paypal_not_configured",
  "paypal_login_denied",
  "paypal_login_failed",
  "paypal_login_state_invalid",
  "paypal_login_rate_limited",
]);

function singleParameter(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : undefined;
}

function trustedClientKey(request: Request): string {
  // Render documents its load balancer's x-forwarded-for first value as the real client IP.
  // Other forwarded headers are used only when provided by an edge that replaces them.
  const edgeClient = callerOf(request);
  return edgeClient.length <= 64 && isIP(edgeClient) ? edgeClient : "unknown";
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header || header.length > 8192) return undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    try {
      const value = decodeURIComponent(pair.slice(separator + 1).trim());
      return value.length <= 128 ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function stateCookie(value: string, expiresAt: Date, secure: boolean): string {
  return `${PAYPAL_LOGIN_STATE_COOKIE}=${encodeURIComponent(value)}; Path=${PAYPAL_LOGIN_CALLBACK_PATH}; Expires=${expiresAt.toUTCString()}; Max-Age=${STATE_COOKIE_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function clearStateCookie(secure: boolean): string {
  return `${PAYPAL_LOGIN_STATE_COOKIE}=; Path=${PAYPAL_LOGIN_CALLBACK_PATH}; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function cookieEnvironment(env: Environment, secure: boolean): NodeJS.ProcessEnv {
  return { ...env, NODE_ENV: secure ? "production" : "development" } as NodeJS.ProcessEnv;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function safeErrorRedirect(env: Environment, error: string, cookies: string[] = []): Response {
  try {
    const url = new URL("/seller/owner-sign-in", paypalLoginOrigin(env));
    url.searchParams.set("error", LOGIN_ERROR_CODES.has(error) ? error : "paypal_login_failed");
    return redirect(url.toString(), cookies);
  } catch {
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    return new Response(JSON.stringify({ error: { code: "PAYPAL_LOGIN_NOT_CONFIGURED" } }), { status: 503, headers });
  }
}

function safeAlreadySignedInRedirect(env: Environment, cookies: string[] = []): Response {
  try {
    const url = new URL("/seller/shops", paypalLoginOrigin(env));
    url.searchParams.set("error", "paypal_login_already_signed_in");
    return redirect(url.toString(), cookies);
  } catch {
    return safeErrorRedirect(env, "paypal_login_failed", cookies);
  }
}

async function ownerSessionState(request: Request, store: IdentityStore, now: Date) {
  const hasCookie = request.headers.get("cookie")?.split(";").some((part) => {
    const separator = part.indexOf("=");
    return (separator < 0 ? part.trim() : part.slice(0, separator).trim()) === OWNER_SESSION_COOKIE;
  }) ?? false;
  if (!hasCookie) return { active: false, stale: false };
  const token = await ownerCookieValue(OWNER_SESSION_COOKIE, request);
  try {
    await requireOwnerSession(store, token, now);
    return { active: true, stale: false };
  } catch (error) {
    if (error instanceof IdentityError && error.code === "UNAUTHORIZED") {
      return { active: false, stale: true };
    }
    throw error;
  }
}

/** Framework-neutral OAuth routes used by the Next.js route handlers and real Postgres tests. */
export function createPayPalLoginHttpHandlers(input: {
  store: IdentityStore;
  limiter: AttemptLimiter;
  env?: Environment;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}) {
  const env = input.env ?? process.env;
  const now = input.now ?? (() => new Date());
  const paypal = createPayPalLoginAdapter(env, input.fetchImpl ?? fetch);

  return {
    async start(request: Request): Promise<Response> {
      const sessionNow = now();
      let ownerState: Awaited<ReturnType<typeof ownerSessionState>>;
      try {
        ownerState = await ownerSessionState(request, input.store, sessionNow);
      } catch {
        return safeErrorRedirect(env, "paypal_login_failed");
      }
      if (ownerState.active) return safeAlreadySignedInRedirect(env);
      let callbackUrl: string;
      let origin: URL;
      try {
        paypal.assertConfigured();
        origin = paypalLoginOrigin(env);
        callbackUrl = paypalLoginCallbackUrl(env);
      } catch {
        const secure = new URL(request.url).protocol === "https:";
        return safeErrorRedirect(env, "paypal_not_configured", ownerState.stale ? clearOwnerCookies(cookieEnvironment(env, secure)) : []);
      }

      const requestTime = now();
      try {
        if (!(await input.limiter.consume(`paypal-login-start:${trustedClientKey(request)}`, 20, 60 * 60_000, requestTime))) {
          return safeErrorRedirect(env, "paypal_login_rate_limited", ownerState.stale ? clearOwnerCookies(cookieEnvironment(env, origin.protocol === "https:")) : []);
        }
      } catch {
        return safeErrorRedirect(env, "paypal_login_failed", ownerState.stale ? clearOwnerCookies(cookieEnvironment(env, origin.protocol === "https:")) : []);
      }
      try {
        const attempt = await createPayPalLoginAttempt(input.store, requestTime);
        const authorizationUrl = paypal.authorizationUrl(attempt.state, callbackUrl);
        const cookieEnv = cookieEnvironment(env, origin.protocol === "https:");
        return redirect(authorizationUrl.toString(), [
          ...(ownerState.stale ? clearOwnerCookies(cookieEnv) : []),
          stateCookie(attempt.browserBinding, attempt.expiresAt, origin.protocol === "https:"),
        ]);
      } catch {
        return safeErrorRedirect(env, "paypal_login_failed");
      }
    },

    async callback(request: Request): Promise<Response> {
      let origin: URL;
      try {
        origin = paypalLoginOrigin(env);
      } catch {
        const clear = clearStateCookie(new URL(request.url).protocol === "https:");
        return safeErrorRedirect(env, "paypal_login_state_invalid", [clear]);
      }
      const clear = clearStateCookie(origin.protocol === "https:");
      const url = new URL(request.url);
      const state = singleParameter(url, "state");
      const browserBinding = cookieValue(request, PAYPAL_LOGIN_STATE_COOKIE);
      if (!state || !STATE_PATTERN.test(state) || !browserBinding || !STATE_PATTERN.test(browserBinding)) {
        return safeErrorRedirect(env, "paypal_login_state_invalid", [clear]);
      }
      let consumed: boolean;
      try {
        consumed = await consumePayPalLoginAttempt(input.store, state, browserBinding, now());
      } catch {
        return safeErrorRedirect(env, "paypal_login_failed", [clear]);
      }
      if (!consumed) return safeErrorRedirect(env, "paypal_login_state_invalid", [clear]);

      // Consume state before processing denial or profile data so every valid-state return is one-time.
      if (url.searchParams.getAll("error").length > 0) {
        return safeErrorRedirect(env, "paypal_login_denied", [clear]);
      }
      const code = singleParameter(url, "code");
      if (!code || code.length > 4096 || /[\u0000-\u001f\u007f]/.test(code)) {
        return safeErrorRedirect(env, "paypal_login_failed", [clear]);
      }
      let ownerState: Awaited<ReturnType<typeof ownerSessionState>>;
      try {
        ownerState = await ownerSessionState(request, input.store, now());
      } catch {
        return safeErrorRedirect(env, "paypal_login_failed", [clear]);
      }
      if (ownerState.active) return safeAlreadySignedInRedirect(env, [clear]);

      try {
        const identity = await paypal.userInfo(code);
        const authenticated = await authenticatePayPalOwner(input.store, identity, now());

        const cookieEnv = cookieEnvironment(env, origin.protocol === "https:");
        const cookies = [
          ...(ownerState.stale ? clearOwnerCookies(cookieEnv) : []),
          ownerSessionCookie(authenticated.sessionToken, authenticated.expiresAt, cookieEnv),
          clearLegacySellerSessionCookie(cookieEnv),
          clearSelectedOwnerShopCookie(cookieEnv),
          clear,
        ];
        const destination = authenticated.shops.length === 0 ? "/seller/paypal-onboarding" : "/seller/shops";
        return redirect(new URL(destination, origin).toString(), cookies);
      } catch {
        return safeErrorRedirect(env, "paypal_login_failed", [clear]);
      }
    },
  };
}
