import "server-only";

import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../db/client";
import { shops } from "../db/schema";
import { ServiceError, parseInput } from "../errors";
import { verifyAccessCode } from "./access-code";
import { sign, verifySignature } from "./signing";

// A minimal demo session, not a production identity system. Naming a shop grants nothing:
// the shop comes from a signed session that requires that shop's access code. Seller
// mutations must take the shop from requireSellerShop, never from request input.

export const SELLER_SESSION_COOKIE = "agentshelf_seller_session";

const PURPOSE = "seller-session:v1";
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;

const sellerSignInInput = z.strictObject({
  shopSlug: z.string().trim().min(1).max(100),
  accessCode: z.string().min(1).max(200),
});

const sessionPayload = z.strictObject({ shopId: z.uuid(), exp: z.int() });

function encodeSession(shopId: string, expiresAt: Date): string {
  const payload = Buffer.from(
    JSON.stringify({ shopId, exp: expiresAt.getTime() }),
  ).toString("base64url");
  return `${payload}.${sign(PURPOSE, payload)}`;
}

export function readSellerSession(
  token: string | undefined,
  now: Date = new Date(),
): { shopId: string; expiresAt: Date } | null {
  const [payload, signature, ...rest] = (token ?? "").split(".");
  if (!payload || !signature || rest.length > 0) {
    return null;
  }
  if (!verifySignature(PURPOSE, payload, signature)) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = sessionPayload.safeParse(decoded);
  if (!parsed.success || parsed.data.exp <= now.getTime()) {
    return null;
  }
  return { shopId: parsed.data.shopId, expiresAt: new Date(parsed.data.exp) };
}

export async function signInSeller(
  db: Db,
  rawInput: unknown,
  now: Date = new Date(),
): Promise<{ shopId: string; token: string; expiresAt: Date }> {
  const { shopSlug, accessCode } = parseInput(sellerSignInInput, rawInput);
  const [shop] = await db
    .select({ id: shops.id, accessCodeHash: shops.sellerAccessCodeHash })
    .from(shops)
    .where(eq(shops.slug, shopSlug));

  // The same answer for an unknown shop, a shop with no code and a wrong code.
  const granted =
    shop?.accessCodeHash != null &&
    (await verifyAccessCode(accessCode, shop.accessCodeHash));
  if (!granted) {
    throw new ServiceError(
      "UNAUTHORIZED",
      "This shop and access code do not match.",
    );
  }

  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
  return {
    shopId: shop.id,
    token: encodeSession(shop.id, expiresAt),
    expiresAt,
  };
}

// The shop a seller request is allowed to act on. Returns no credential columns.
export async function requireSellerShop(
  db: Db,
  token: string | undefined,
  now: Date = new Date(),
) {
  const unauthorized = new ServiceError(
    "UNAUTHORIZED",
    "Sign in to this shop first.",
  );
  const session = readSellerSession(token, now);
  if (!session) {
    throw unauthorized;
  }
  const [shop] = await db
    .select({
      id: shops.id,
      slug: shops.slug,
      name: shops.name,
      currency: shops.currency,
      timezone: shops.timezone,
    })
    .from(shops)
    .where(eq(shops.id, session.shopId));
  if (!shop) {
    throw unauthorized;
  }
  return { ...shop, sessionExpiresAt: session.expiresAt };
}
