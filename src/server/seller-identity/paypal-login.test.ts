import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { AttemptLimiter, IdentityStore } from "./service";
import { createPayPalLoginHttpHandlers } from "./paypal-login-http";

function makeStore() {
  const sessions = new Map<string, { ownerId: string; expiresAt: Date }>();
  const states = new Map<string, { browserBindingHash: string; expiresAt: Date; consumed: boolean }>();
  const owners = new Map<string, { id: string; username: string; passwordHash: string | null }>();
  const profiles = new Map<string, { displayName: string | null; email: string | null }>();
  const subjects = new Map<string, string>();
  const store = {
    async findOwnerById(ownerId: string) {
      const owner = owners.get(ownerId);
      return owner ? { id: owner.id, username: owner.username } : null;
    },
    async findPayPalProfileByOwnerId(ownerId: string) { return profiles.get(ownerId) ?? null; },
    async createPayPalLoginState(input: { stateHash: string; browserBindingHash: string; expiresAt: Date }) {
      states.set(input.stateHash, { browserBindingHash: input.browserBindingHash, expiresAt: input.expiresAt, consumed: false });
    },
    async consumePayPalLoginState(input: { stateHash: string; browserBindingHash: string; now: Date }) {
      const state = states.get(input.stateHash);
      if (!state || state.consumed || state.expiresAt <= input.now || state.browserBindingHash !== input.browserBindingHash) return false;
      state.consumed = true;
      return true;
    },
    async findOrCreatePayPalOwnerIdentityAtomic(input: { subjectHash: string; syntheticUsername: string; profile: { displayName: string | null; email: string | null } }) {
      const existingId = subjects.get(input.subjectHash);
      if (existingId) {
        profiles.set(existingId, input.profile);
        const owner = owners.get(existingId)!;
        return { owner: { id: owner.id, username: owner.username }, profile: input.profile, created: false };
      }
      const id = `owner-${owners.size + 1}`;
      owners.set(id, { id, username: input.syntheticUsername, passwordHash: null });
      profiles.set(id, input.profile);
      subjects.set(input.subjectHash, id);
      return { owner: { id, username: input.syntheticUsername }, profile: input.profile, created: true };
    },
    async createSession(input: { ownerId: string; tokenHash: string; expiresAt: Date }) { sessions.set(input.tokenHash, { ownerId: input.ownerId, expiresAt: input.expiresAt }); },
    async findActiveSession(tokenHash: string, now: Date) {
      const session = sessions.get(tokenHash);
      return session && session.expiresAt > now ? session : null;
    },
    async listOwnerShops() { return []; },
  } as unknown as IdentityStore;
  return { store, owners, profiles, subjects, states, sessions };
}

class Limiter implements AttemptLimiter {
  readonly keys: string[] = [];
  blocked = false;
  async consume(key: string) {
    this.keys.push(key);
    return !this.blocked;
  }
}

const env = {
  APP_ORIGIN: "https://agentshelf.example",
  PAYPAL_LOGIN_CLIENT_ID: "sandbox-client-id",
  PAYPAL_LOGIN_CLIENT_SECRET: "sandbox-client-secret",
};

function getCookie(response: Response, name: string) {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
}

function cookiePair(cookie: string) {
  return cookie.split(";", 1)[0];
}

describe("PayPal sandbox login HTTP handlers", () => {
  it("fails closed before persisting OAuth state when Login credentials are missing", async () => {
    const { store, states } = makeStore();
    const handlers = createPayPalLoginHttpHandlers({
      store,
      limiter: new Limiter(),
      env: { APP_ORIGIN: "https://agentshelf.example" },
    });
    const response = await handlers.start(new Request("https://agentshelf.example/api/seller/identity/paypal/start"));
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("paypal_not_configured");
    expect(states.size).toBe(0);
  });

  it("starts with bounded trusted-client rate limiting and clears stale owner cookies", async () => {
    const { store } = makeStore();
    const limiter = new Limiter();
    const handlers = createPayPalLoginHttpHandlers({ store, limiter, env, now: () => new Date("2026-11-06T12:00:00Z") });
    const request = new Request("https://agentshelf.example/api/seller/identity/paypal/start", {
      headers: { cookie: "agentshelf_owner_session=revoked-token", "cf-connecting-ip": "203.0.113.5", "x-forwarded-for": "198.51.100.99" },
    });
    const response = await handlers.start(request);
    expect(response.status).toBe(303);
    const authorization = new URL(response.headers.get("location")!);
    expect(authorization.origin).toBe("https://www.sandbox.paypal.com");
    expect(authorization.pathname).toBe("/connect");
    expect(authorization.searchParams.get("redirect_uri")).toBe("https://agentshelf.example/api/seller/identity/paypal/callback");
    expect(authorization.searchParams.get("scope")).toBe("openid profile email");
    expect(authorization.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(limiter.keys).toEqual(["paypal-login-start:203.0.113.5"]);
    expect(response.headers.getSetCookie().some((value) => value.startsWith("agentshelf_owner_session=;"))).toBe(true);
    expect(getCookie(response, "agentshelf_paypal_login_state")).toContain("HttpOnly");
    expect(getCookie(response, "agentshelf_paypal_login_state")).toContain("SameSite=Lax");
  });

  it("rejects active owner sessions and returns a safe rate-limit redirect", async () => {
    const limiter = new Limiter();
    const sessionStore = makeStore();
    const ownerId = "existing";
    sessionStore.owners.set(ownerId, { id: ownerId, username: "existing", passwordHash: "ignored" });
    sessionStore.sessions.set(createHash("sha256").update("bad-token").digest("hex"), { ownerId, expiresAt: new Date("2026-11-06T13:00:00Z") });
    const handlers = createPayPalLoginHttpHandlers({ store: sessionStore.store, limiter, env, now: () => new Date("2026-11-06T12:00:00Z") });
    const active = await handlers.start(new Request("https://agentshelf.example/api/seller/identity/paypal/start", {
      headers: { cookie: "agentshelf_owner_session=bad-token" },
    }));
    expect(new URL(active.headers.get("location")!).searchParams.get("error")).toBe("paypal_login_already_signed_in");

    limiter.blocked = true;
    const limited = await handlers.start(new Request("https://agentshelf.example/api/seller/identity/paypal/start", {
      headers: { "cf-connecting-ip": "203.0.113.7" },
    }));
    expect(new URL(limited.headers.get("location")!).searchParams.get("error")).toBe("paypal_login_rate_limited");
  });

  it("consumes one-time state and creates a passwordless owner session without linking by email", async () => {
    const { store, owners, profiles, subjects } = makeStore();
    const limiter = new Limiter();
    const now = new Date("2026-11-06T12:00:00Z");
    let tokenCalls = 0;
    const tokenRequests: Array<{ url: string; authorization: string | null; redirect: RequestRedirect | undefined; hasSignal: boolean }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/oauth2/token")) {
        tokenCalls += 1;
        tokenRequests.push({
          url,
          authorization: new Headers(init?.headers).get("authorization"),
          redirect: init?.redirect,
          hasSignal: init?.signal instanceof AbortSignal,
        });
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic /);
        const grant = new URLSearchParams(String(init?.body));
        if (tokenCalls === 1) {
          expect(grant.get("grant_type")).toBe("authorization_code");
          expect(grant.get("code")).toBe("single-use");
          return Response.json({ access_token: "initial-access-token-sentinel", refresh_token: "refresh-token-sentinel", token_type: "Bearer", expires_in: 300 });
        }
        expect(tokenCalls).toBe(2);
        expect(grant.get("grant_type")).toBe("refresh_token");
        expect(grant.get("refresh_token")).toBe("refresh-token-sentinel");
        expect(grant.get("code")).toBeNull();
        return Response.json({ access_token: "refreshed-access-token-sentinel", token_type: "Bearer", expires_in: 300 });
      }
      expect(url).toBe("https://api-m.sandbox.paypal.com/v1/identity/openidconnect/userinfo?schema=openid");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer refreshed-access-token-sentinel");
      return Response.json({ sub: " stable-subject ", name: "PayPal Seller", email: "seller@example.test" });
    };
    const handlers = createPayPalLoginHttpHandlers({ store, limiter, env, fetchImpl, now: () => now });
    const started = await handlers.start(new Request("https://agentshelf.example/api/seller/identity/paypal/start", {
      headers: { "cf-connecting-ip": "203.0.113.9" },
    }));
    const authorization = new URL(started.headers.get("location")!);
    const state = authorization.searchParams.get("state")!;
    const stateCookie = getCookie(started, "agentshelf_paypal_login_state")!;
    const callback = () => handlers.callback(new Request(`https://agentshelf.example/api/seller/identity/paypal/callback?code=single-use&state=${encodeURIComponent(state)}`, {
      headers: { cookie: cookiePair(stateCookie) },
    }));
    const response = await callback();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://agentshelf.example/seller/paypal-onboarding");
    const ownerCookie = response.headers.getSetCookie().find((cookie) => cookie.startsWith("agentshelf_owner_session="));
    expect(ownerCookie).toContain("HttpOnly");
    expect(ownerCookie).toContain("Secure");
    expect(owners.size).toBe(1);
    const createdOwner = [...owners.values()][0];
    expect(createdOwner.passwordHash).toBeNull();
    expect(profiles.get(createdOwner.id)).toEqual({ displayName: "PayPal Seller", email: "seller@example.test" });
    expect(tokenCalls).toBe(2);
    expect(tokenRequests).toEqual([
      { url: "https://api-m.sandbox.paypal.com/v1/oauth2/token", authorization: `Basic ${Buffer.from("sandbox-client-id:sandbox-client-secret").toString("base64")}`, redirect: "error", hasSignal: true },
      { url: "https://api-m.sandbox.paypal.com/v1/oauth2/token", authorization: `Basic ${Buffer.from("sandbox-client-id:sandbox-client-secret").toString("base64")}`, redirect: "error", hasSignal: true },
    ]);
    expect([...subjects.keys()]).toHaveLength(1);
    expect([...subjects.keys()][0]).not.toContain("seller@example.test");
    const replay = await callback();
    expect(new URL(replay.headers.get("location")!).searchParams.get("error")).toBe("paypal_login_state_invalid");
    expect(owners.size).toBe(1);
  });

  it("rejects duplicate callback parameters and denial without clearing a legacy seller session", async () => {
    const { store } = makeStore();
    const limiter = new Limiter();
    const handlers = createPayPalLoginHttpHandlers({ store, limiter, env });
    const started = await handlers.start(new Request("https://agentshelf.example/api/seller/identity/paypal/start", {
      headers: { "cf-connecting-ip": "203.0.113.10" },
    }));
    const state = new URL(started.headers.get("location")!).searchParams.get("state")!;
    const stateCookie = cookiePair(getCookie(started, "agentshelf_paypal_login_state")!);
    const duplicate = await handlers.callback(new Request(`https://agentshelf.example/api/seller/identity/paypal/callback?state=${state}&state=${state}&code=a&code=b`, {
      headers: { cookie: stateCookie },
    }));
    expect(new URL(duplicate.headers.get("location")!).searchParams.get("error")).toBe("paypal_login_state_invalid");
    const denied = await handlers.callback(new Request(`https://agentshelf.example/api/seller/identity/paypal/callback?state=${state}&error=access_denied`, {
      headers: { cookie: `${stateCookie}; agentshelf_seller_session=legacy-session` },
    }));
    expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe("paypal_login_denied");
    expect(denied.headers.getSetCookie().some((cookie) => cookie.startsWith("agentshelf_seller_session="))).toBe(false);
  });

  it.each([
    ["token endpoint HTTP failure", async () => Response.json({ error: "invalid_grant", error_description: "TOKEN_DESCRIPTION_SENTINEL" }, { status: 401 }), "token_http", { stage: "token_response", reason: "http_error", httpStatus: 401, providerCode: "invalid_grant" }],
    ["unknown provider error", async () => Response.json({ error: "ERROR_SECRET_SENTINEL", name: "NAME_SECRET_SENTINEL", message: "MESSAGE_SECRET_SENTINEL" }, { status: 401 }), "token_http", { stage: "token_response", reason: "http_error", httpStatus: 401 }],
    ["malformed token JSON", async () => new Response("TOKEN_JSON_SENTINEL", { status: 200 }), "stop", { stage: "token_response", reason: "invalid_json", httpStatus: 200 }],
    ["malformed token response", async () => Response.json({ access_token: "", token_type: "Bearer", expires_in: 300 }), "stop", { stage: "token_response", reason: "invalid_response", httpStatus: 200 }],
    ["missing refresh token", async () => Response.json({ access_token: "INITIAL_ACCESS_SENTINEL", token_type: "Bearer", expires_in: 300 }), "missing_refresh", { stage: "token_response", reason: "invalid_response", httpStatus: 200 }],
    ["refresh endpoint network failure", async () => Response.json({ access_token: "INITIAL_ACCESS_SENTINEL", refresh_token: "REFRESH_TOKEN_SENTINEL", token_type: "Bearer", expires_in: 300 }), "refresh_network", { stage: "refresh_exchange", reason: "transport_error" }],
    ["refresh endpoint HTTP failure", async () => Response.json({ access_token: "INITIAL_ACCESS_SENTINEL", refresh_token: "REFRESH_TOKEN_SENTINEL", token_type: "Bearer", expires_in: 300 }), "refresh_http", { stage: "refresh_response", reason: "http_error", httpStatus: 401, providerCode: "AUTHENTICATION_FAILURE" }],
    ["malformed refresh response", async () => Response.json({ access_token: "INITIAL_ACCESS_SENTINEL", refresh_token: "REFRESH_TOKEN_SENTINEL", token_type: "Bearer", expires_in: 300 }), "refresh_invalid", { stage: "refresh_response", reason: "invalid_response", httpStatus: 200 }],
    ["userinfo network failure", async () => Response.json({ access_token: "INITIAL_ACCESS_SENTINEL", refresh_token: "REFRESH_TOKEN_SENTINEL", token_type: "Bearer", expires_in: 300 }), "network", { stage: "userinfo_request", reason: "transport_error" }],
    ["userinfo HTTP failure", async () => Response.json({ access_token: "INITIAL_ACCESS_SENTINEL", refresh_token: "REFRESH_TOKEN_SENTINEL", token_type: "Bearer", expires_in: 300 }), "userinfo_http", { stage: "userinfo_request", reason: "http_error", httpStatus: 401 }],
    ["profile missing sub", async () => Response.json({ access_token: "INITIAL_ACCESS_SENTINEL", refresh_token: "REFRESH_TOKEN_SENTINEL", token_type: "Bearer", expires_in: 300 }), "missing_sub", { stage: "profile_validation", reason: "missing_sub", httpStatus: 200 }],
    ["profile invalid email", async () => Response.json({ access_token: "INITIAL_ACCESS_SENTINEL", refresh_token: "REFRESH_TOKEN_SENTINEL", token_type: "Bearer", expires_in: 300 }), "invalid_email", { stage: "profile_validation", reason: "invalid_email", httpStatus: 200 }],
  ])("does not create an owner after %s", async (label, tokenResponse, failure, expectedLog) => {
    const { store, owners, sessions } = makeStore();
    const limiter = new Limiter();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      fetchCalls += 1;
      if (String(input).endsWith("/v1/oauth2/token")) {
        const grant = new URLSearchParams(String(init?.body));
        if (fetchCalls === 1) {
          if (["missing_refresh", "token_http", "stop"].includes(failure)) return await tokenResponse();
          return Response.json({ access_token: "INITIAL_ACCESS_SENTINEL", refresh_token: "REFRESH_TOKEN_SENTINEL", token_type: "Bearer", expires_in: 300 });
        }
        expect(grant.get("grant_type")).toBe("refresh_token");
        expect(grant.get("refresh_token")).toBe("REFRESH_TOKEN_SENTINEL");
        if (failure === "refresh_network") throw new Error("simulated refresh endpoint transport failure");
        if (failure === "refresh_http") return Response.json({ name: "AUTHENTICATION_FAILURE", message: "REFRESH_BODY_SENTINEL" }, { status: 401 });
        if (failure === "refresh_invalid") return Response.json({ access_token: "", token_type: "Bearer", expires_in: 300 });
        return Response.json({ access_token: "REFRESHED_ACCESS_SENTINEL", token_type: "Bearer", expires_in: 300 });
      }
      if (failure === "network") throw new Error("simulated provider transport failure");
      if (failure === "userinfo_http") return new Response("USERINFO_BODY_SENTINEL", { status: 401 });
      if (failure === "missing_sub") return Response.json({ email: "EMAIL_SENTINEL@example.test", payer_id: "PROFILE_SENTINEL" });
      if (failure === "invalid_email") return Response.json({ sub: "SUBJECT_SENTINEL", email: "EMAIL_SENTINEL", name: "PROFILE_SENTINEL" });
      throw new Error("unexpected second provider request");
    };
    const handlers = createPayPalLoginHttpHandlers({ store, limiter, env, fetchImpl });
    const started = await handlers.start(new Request("https://agentshelf.example/api/seller/identity/paypal/start", {
      headers: { "cf-connecting-ip": "203.0.113.11" },
    }));
    const authorization = new URL(started.headers.get("location")!);
    const stateCookie = cookiePair(getCookie(started, "agentshelf_paypal_login_state")!);
    const callback = await handlers.callback(new Request(`https://agentshelf.example/api/seller/identity/paypal/callback?state=${authorization.searchParams.get("state")}&code=code`, {
      headers: { cookie: stateCookie },
    }));
    expect(new URL(callback.headers.get("location")!).searchParams.get("error")).toBe("paypal_login_failed");
    expect(owners.size).toBe(0);
    expect(sessions.size).toBe(0);
    if (["token_http", "missing_refresh", "stop"].includes(failure)) expect(fetchCalls).toBe(1);
    else if (["refresh_network", "refresh_http", "refresh_invalid"].includes(failure)) expect(fetchCalls).toBe(2);
    else expect(fetchCalls).toBe(3);
    expect(warning).toHaveBeenCalledTimes(1);
    const event = warning.mock.calls[0][0];
    expect(JSON.parse(event!)).toEqual({ event: "paypal_login_failed", ...expectedLog });
    const serialized = JSON.stringify(warning.mock.calls);
    for (const sentinel of [
      "TOKEN_BODY_SENTINEL", "TOKEN_JSON_SENTINEL", "TOKEN_DESCRIPTION_SENTINEL", "ERROR_SECRET_SENTINEL", "NAME_SECRET_SENTINEL", "MESSAGE_SECRET_SENTINEL",
      "INITIAL_ACCESS_SENTINEL", "REFRESH_TOKEN_SENTINEL", "REFRESHED_ACCESS_SENTINEL", "REFRESH_BODY_SENTINEL",
      "USERINFO_BODY_SENTINEL", "EMAIL_SENTINEL", "PROFILE_SENTINEL", "SUBJECT_SENTINEL",
      "code=code", authorization.searchParams.get("state")!,
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    warning.mockRestore();
  });

  it("logs only a closed owner-session persistence diagnostic on database failure", async () => {
    const { store, owners, sessions } = makeStore();
    (store as IdentityStore).findOrCreatePayPalOwnerIdentityAtomic = async () => {
      throw new Error("DB_SENTINEL email=EMAIL_SENTINEL sub=SUBJECT_SENTINEL token=TOKEN_SENTINEL");
    };
    const limiter = new Limiter();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) return Response.json({ access_token: "INITIAL_ACCESS_TOKEN_SENTINEL", refresh_token: "REFRESH_TOKEN_SENTINEL", token_type: "Bearer", expires_in: 300 });
      if (fetchCalls === 2) return Response.json({ access_token: "REFRESHED_ACCESS_TOKEN_SENTINEL", token_type: "Bearer", expires_in: 300 });
      return Response.json({ sub: "SUBJECT_SENTINEL", name: "PROFILE_SENTINEL", email: "EMAIL_SENTINEL@example.test" });
    };
    const handlers = createPayPalLoginHttpHandlers({ store, limiter, env, fetchImpl });
    const started = await handlers.start(new Request("https://agentshelf.example/api/seller/identity/paypal/start", {
      headers: { "cf-connecting-ip": "203.0.113.12" },
    }));
    const authorization = new URL(started.headers.get("location")!);
    const stateCookie = cookiePair(getCookie(started, "agentshelf_paypal_login_state")!);
    const callback = await handlers.callback(new Request(`https://agentshelf.example/api/seller/identity/paypal/callback?state=${authorization.searchParams.get("state")}&code=CODE_SENTINEL`, {
      headers: { cookie: stateCookie },
    }));
    expect(new URL(callback.headers.get("location")!).searchParams.get("error")).toBe("paypal_login_failed");
    expect(owners.size).toBe(0);
    expect(sessions.size).toBe(0);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(JSON.stringify({ event: "paypal_login_failed",
      stage: "owner_session",
      reason: "persistence_failure",
    }));
    const serialized = JSON.stringify(warning.mock.calls);
    for (const sentinel of ["DB_SENTINEL", "EMAIL_SENTINEL", "SUBJECT_SENTINEL", "TOKEN_SENTINEL", "INITIAL_ACCESS_TOKEN_SENTINEL", "REFRESH_TOKEN_SENTINEL", "REFRESHED_ACCESS_TOKEN_SENTINEL", "PROFILE_SENTINEL", "CODE_SENTINEL"]) {
      expect(serialized).not.toContain(sentinel);
    }
    warning.mockRestore();
  });
});
