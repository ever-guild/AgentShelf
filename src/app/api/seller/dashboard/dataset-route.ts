import { connection } from "next/server";

import { currentSeller } from "@/server/auth/current-seller";
import { getDb } from "@/server/db";
import type { Db } from "@/server/db/client";
import { errorResponse } from "@/server/http";
import type { DashboardShop } from "@/server/services/seller-dashboard";

type Dataset = (db: Db, shop: DashboardShop, rawQuery: unknown) => Promise<unknown>;

// One dashboard dataset as a GET handler. The shop comes from the session and nothing else, and
// nothing may keep a copy, because the answer differs per session and goes out of date quickly.
export function datasetRoute(dataset: Dataset) {
  return async function GET(request: Request) {
    // Outside the try, because the build's prerender of this route ends with this rejecting.
    await connection();
    try {
      const shop = await currentSeller();
      const query = Object.fromEntries(new URL(request.url).searchParams);
      return Response.json(await dataset(getDb(), shop, query), {
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
