import "server-only";

import { cookies } from "next/headers";

import type { AuthenticatedOwner, SellerShopPrincipal } from "../contracts/seller-identity";
import { SELLER_SESSION_COOKIE } from "../auth/seller-session";
import { readBodyWithin } from "../http";
import { publicOrigin } from "../public-origin";
import {
  IdentityError,
  listOwnerShops,
  requireOwnerSession,
  requireSellerShopPrincipal,
  type ShopRecord,
} from "./service";
import { ownerIdentityRuntime } from "./runtime";

export const OWNER_SESSION_COOKIE = "agentshelf_owner_session";
export const OWNER_SELECTED_SHOP_COOKIE = "agentshelf_owner_shop";

const ERROR_STATUS: Record<IdentityError["code"], number> = {
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  RATE_LIMITED: 429,
  REGISTRATION_CONFLICT: 409,
  SHOP_SLUG_UNAVAILABLE: 409,
  AGENT_AUTHORIZATION_REQUIRED: 401,
};

function cookieFromHeader(header: string | null, name: string): string | undefined {
  if (!header || header.length > 8192) return undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    const value = pair.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function ownerCookieValue(
  name: typeof OWNER_SESSION_COOKIE | typeof OWNER_SELECTED_SHOP_COOKIE,
  request?: Request,
): Promise<string | undefined> {
  if (request) return cookieFromHeader(request.headers.get("cookie"), name);
  const store = await cookies();
  return store.get(name)?.value;
}

export async function hasOwnerSessionCookie(request?: Request): Promise<boolean> {
  if (request) {
    const header = request.headers.get("cookie");
    if (!header) return false;
    if (header.length > 8192) return true;
    return header.split(";").some((pair) => {
      const separator = pair.indexOf("=");
      const name = separator < 0 ? pair.trim() : pair.slice(0, separator).trim();
      return name === OWNER_SESSION_COOKIE;
    });
  }
  const store = await cookies();
  return store.has(OWNER_SESSION_COOKIE);
}

export async function currentOwner(
  request?: Request,
  now = new Date(),
): Promise<AuthenticatedOwner> {
  const token = await ownerCookieValue(OWNER_SESSION_COOKIE, request);
  return requireOwnerSession(ownerIdentityRuntime().store, token, now);
}

/** Resolve a requested or selected shop only after checking its membership for this owner. */
export async function currentOwnerShopPrincipal(
  request?: Request,
  requestedShopId?: string,
  now = new Date(),
): Promise<SellerShopPrincipal> {
  return (await currentOwnerShopContext(request, requestedShopId, now)).principal;
}

export async function currentOwnerShopContext(
  request?: Request,
  requestedShopId?: string,
  now = new Date(),
): Promise<{ owner: AuthenticatedOwner; principal: SellerShopPrincipal }> {
  const owner = await currentOwner(request, now);
  const selectedShopId = requestedShopId ??
    (await ownerCookieValue(OWNER_SELECTED_SHOP_COOKIE, request));
  if (!selectedShopId) {
    throw new IdentityError("UNAUTHORIZED", "Select a shop before continuing.");
  }
  const principal = await requireSellerShopPrincipal(ownerIdentityRuntime().store, owner, selectedShopId);
  return { owner, principal };
}

export function ownerShopResponse(shop: ShopRecord) {
  return {
    id: shop.id,
    name: shop.name,
    slug: shop.slug,
    location: shop.location,
    currency: shop.currency,
    timezone: shop.timezone,
  };
}

export async function currentOwnerShops(owner: AuthenticatedOwner) {
  const { store } = ownerIdentityRuntime();
  return (await listOwnerShops(store, owner)).map(ownerShopResponse);
}

/** Mutating browser endpoints require JSON and an exact same-origin Origin header. */
export function requireSameOriginJson(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): void {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const origin = request.headers.get("origin");
  if (contentType !== "application/json" || !origin) {
    throw new IdentityError("UNAUTHORIZED", "This request is not allowed.");
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new IdentityError("UNAUTHORIZED", "This request is not allowed.");
  }
  let normalizedOrigin: string;
  try {
    const parsed = new URL(origin);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("Invalid origin");
    }
    normalizedOrigin = parsed.origin;
    if (normalizedOrigin !== publicOrigin(env)) {
      throw new Error("Origin mismatch");
    }
  } catch {
    throw new IdentityError("UNAUTHORIZED", "This request is not allowed.");
  }
}

export async function parseJsonBody(request: Request): Promise<unknown> {
  const body = await readBodyWithin(request, 16 * 1024);
  if (!body) {
    throw new IdentityError("INVALID_INPUT", "The request is not valid.");
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new IdentityError("INVALID_INPUT", "The request is not valid.");
  }
}

function cookieHeader(name: string, value: string, expiresAt: Date, env = process.env): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const secure = env.NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; Expires=${expiresAt.toUTCString()}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

export function ownerSessionCookie(token: string, expiresAt: Date, env = process.env): string {
  return cookieHeader(OWNER_SESSION_COOKIE, token, expiresAt, env);
}

export function selectedOwnerShopCookie(shopId: string, sessionExpiresAt: Date, env = process.env): string {
  return cookieHeader(OWNER_SELECTED_SHOP_COOKIE, shopId, sessionExpiresAt, env);
}

export function clearOwnerCookies(env = process.env): string[] {
  const secure = env.NODE_ENV === "production" ? "; Secure" : "";
  const expire = "Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0";
  return [OWNER_SESSION_COOKIE, OWNER_SELECTED_SHOP_COOKIE].map(
    (name) => `${name}=; Path=/; ${expire}; HttpOnly; SameSite=Lax${secure}`,
  );
}

export function clearSelectedOwnerShopCookie(env = process.env): string {
  const secure = env.NODE_ENV === "production" ? "; Secure" : "";
  const expire = "Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0";
  return `${OWNER_SELECTED_SHOP_COOKIE}=; Path=/; ${expire}; HttpOnly; SameSite=Lax${secure}`;
}

export function clearLegacySellerSessionCookie(env = process.env): string {
  const secure = env.NODE_ENV === "production" ? "; Secure" : "";
  const expire = "Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0";
  return `${SELLER_SESSION_COOKIE}=; Path=/; ${expire}; HttpOnly; SameSite=Lax${secure}`;
}

export function identityJsonResponse(
  body: unknown,
  status = 200,
  setCookies: string[] = [],
): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  for (const cookie of setCookies) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

export function identityNoContentResponse(setCookies: string[] = []): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  for (const cookie of setCookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 204, headers });
}

export function identityErrorResponse(error: unknown): Response {
  if (error instanceof IdentityError) {
    return identityJsonResponse({
      error: {
        code: error.code,
        message: error.message,
        ...(error.authorizationUrl ? { authorizationUrl: error.authorizationUrl } : {}),
      },
    }, ERROR_STATUS[error.code]);
  }
  return identityJsonResponse({ error: { code: "SERVER_ERROR", message: "The request could not be completed." } }, 500);
}
