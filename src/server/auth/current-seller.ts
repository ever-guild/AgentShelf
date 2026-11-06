import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { eq } from "drizzle-orm";

import { getDb } from "../db";
import { shops } from "../db/schema";
import { IdentityError } from "../seller-identity/service";
import {
  currentOwnerShopContext,
  hasOwnerSessionCookie,
  OWNER_SESSION_COOKIE,
} from "../seller-identity/http-auth";
import { ServiceError } from "../errors";
import { SELLER_SESSION_COOKIE, requireSellerShop } from "./seller-session";

// The shop this request's session is signed in to, for routes and pages. Throws UNAUTHORIZED.
// A session's expiry is compared with the current time, so this has to run at request time.
function requestCookie(header: string | null, name: string): string | undefined {
  if (!header || header.length > 8192) return undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function currentSeller(request?: Request) {
  if (!request) await connection();
  const cookieStore = request ? undefined : await cookies();
  const hasOwnerCookie = request
    ? await hasOwnerSessionCookie(request)
    : cookieStore?.has(OWNER_SESSION_COOKIE) ?? false;
  if (hasOwnerCookie) {
    try {
      const { owner, principal } = await currentOwnerShopContext(request);
      const db = getDb();
      const [shop] = await db
        .select({
          id: shops.id,
          slug: shops.slug,
          name: shops.name,
          currency: shops.currency,
          timezone: shops.timezone,
        })
        .from(shops)
        .where(eq(shops.id, principal.shopId));
      if (!shop) throw new IdentityError("UNAUTHORIZED", "This shop is not available to this account.");
      return { ...shop, sessionExpiresAt: owner.expiresAt };
    } catch (error) {
      if (error instanceof IdentityError && error.code === "UNAUTHORIZED") {
        throw new ServiceError("UNAUTHORIZED", "Sign in to this shop first.");
      }
      throw error;
    }
  }
  const legacyToken = request
    ? requestCookie(request.headers.get("cookie"), SELLER_SESSION_COOKIE)
    : cookieStore?.get(SELLER_SESSION_COOKIE)?.value;
  return requireSellerShop(getDb(), legacyToken);
}

// For a page: someone who is not signed in goes to the sign-in page.
export async function currentSellerOrSignIn() {
  try {
    return await currentSeller();
  } catch (error) {
    if (error instanceof ServiceError && error.code === "UNAUTHORIZED") {
      redirect("/seller/sign-in");
    }
    throw error;
  }
}
