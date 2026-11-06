import { connection } from "next/server";

import { buyerReturnResponse } from "@/server/services/buyer-return";

export async function GET(request: Request) {
  await connection();
  return buyerReturnResponse(request, { buyerCancelled: true });
}
