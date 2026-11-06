import { connection } from "next/server";

import { currentSeller } from "@/server/auth/current-seller";
import { getDb } from "@/server/db";
import { errorResponse } from "@/server/http";
import { getSellerSchedule } from "@/server/services/seller-schedule";

// The schedule page polls this. The shop comes from the session, and nothing may keep a copy,
// because the answer differs per session and goes out of date within seconds.
export async function GET(request: Request) {
  // Outside the try, because the build's prerender of this route ends with this rejecting.
  await connection();
  try {
    const shop = await currentSeller();
    const query = Object.fromEntries(new URL(request.url).searchParams);
    return Response.json(await getSellerSchedule(getDb(), shop, query), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
