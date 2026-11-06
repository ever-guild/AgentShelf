import { cookies } from "next/headers";

import { SELLER_SESSION_COOKIE, signInSeller } from "@/server/auth/seller-session";
import { currentSeller } from "@/server/auth/current-seller";
import { getDb } from "@/server/db";
import { errorResponse, readJsonWithin } from "@/server/http";
import {
  OWNER_SELECTED_SHOP_COOKIE,
  OWNER_SESSION_COOKIE,
} from "@/server/seller-identity/http-auth";
import { ownerIdentityRuntime } from "@/server/seller-identity/runtime";
import { signOutOwner } from "@/server/seller-identity/service";

export async function POST(request: Request) {
  try {
    const body: unknown = await readJsonWithin(request);
    const { shopId, token, expiresAt } = await signInSeller(getDb(), body);
    const cookieStore = await cookies();
    const ownerToken = cookieStore.get(OWNER_SESSION_COOKIE)?.value;
    if (ownerToken) await signOutOwner(ownerIdentityRuntime().store, ownerToken);
    cookieStore.delete(OWNER_SESSION_COOKIE);
    cookieStore.delete(OWNER_SELECTED_SHOP_COOKIE);
    cookieStore.set(SELLER_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: expiresAt,
    });
    return Response.json({ shopId, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET() {
  try {
    const { sessionExpiresAt, ...shop } = await currentSeller();
    return Response.json({
      shop,
      expiresAt: sessionExpiresAt.toISOString(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE() {
  const cookieStore = await cookies();
  const ownerToken = cookieStore.get(OWNER_SESSION_COOKIE)?.value;
  if (ownerToken) await signOutOwner(ownerIdentityRuntime().store, ownerToken);
  cookieStore.delete(SELLER_SESSION_COOKIE);
  cookieStore.delete(OWNER_SESSION_COOKIE);
  cookieStore.delete(OWNER_SELECTED_SHOP_COOKIE);
  return new Response(null, { status: 204 });
}
