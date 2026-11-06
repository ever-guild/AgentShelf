import { connection } from "next/server";

import { createPayPalLoginHttpHandlers } from "@/server/seller-identity/paypal-login-http";
import { ownerIdentityRuntime } from "@/server/seller-identity/runtime";

export async function GET(request: Request): Promise<Response> {
  await connection();
  const { store, limiter } = ownerIdentityRuntime();
  return createPayPalLoginHttpHandlers({ store, limiter }).start(request);
}
