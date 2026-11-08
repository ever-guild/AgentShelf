import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

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
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/oauth2/token")) {
        expect(init?.method).toBe("POST");
        expect(String(init?.body)).toContain("grant_type=authorization_code");
        return Response.json({ access_token: "opaque-access-token", token_type: "Bearer", expires_in: 300 });
      }
      expect(url).toBe("https://api-m.sandbox.paypal.com/v1/identity/openidconnect/userinfo?schema=openid");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer opaque-access-token");
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
    ["token endpoint failure", async () => new Response("{}", { status: 401 }), "stop"],
    ["malformed token response", async () => Response.json({ access_token: "", token_type: "Bearer", expires_in: 300 }), "stop"],
    ["userinfo network failure", async () => Response.json({ access_token: "token", token_type: "Bearer", expires_in: 300 }), "network"],
    ["malformed profile", async () => Response.json({ access_token: "token", token_type: "Bearer", expires_in: 300 }), "profile"],
  ])("does not create an owner after %s", async (label, tokenResponse, failure) => {
    const { store, owners, sessions } = makeStore();
    const limiter = new Limiter();
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) return await tokenResponse();
      if (failure === "network") throw new Error("simulated provider transport failure");
      if (failure === "profile") return Response.json({ email: "unverified@example.test" });
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
  });
});
