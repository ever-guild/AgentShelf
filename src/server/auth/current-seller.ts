import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { getDb } from "../db";
import { ServiceError } from "../errors";
import { SELLER_SESSION_COOKIE, requireSellerShop } from "./seller-session";

// The shop this request's session is signed in to, for routes and pages. Throws UNAUTHORIZED.
// A session's expiry is compared with the current time, so this has to run at request time.
export async function currentSeller() {
  await connection();
  const cookieStore = await cookies();
  return requireSellerShop(getDb(), cookieStore.get(SELLER_SESSION_COOKIE)?.value);
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
