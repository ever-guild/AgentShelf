import { cookies } from "next/headers";

import {
  SELLER_SESSION_COOKIE,
  requireSellerShop,
  signInSeller,
} from "@/server/auth/seller-session";
import { getDb } from "@/server/db";
import { errorResponse } from "@/server/http";

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null);
    const { shopId, token, expiresAt } = await signInSeller(getDb(), body);
    const cookieStore = await cookies();
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
    const cookieStore = await cookies();
    const { sessionExpiresAt, ...shop } = await requireSellerShop(
      getDb(),
      cookieStore.get(SELLER_SESSION_COOKIE)?.value,
    );
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
  cookieStore.delete(SELLER_SESSION_COOKIE);
  return new Response(null, { status: 204 });
}
