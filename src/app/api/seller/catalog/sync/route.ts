import { currentSeller } from "@/server/auth/current-seller";
import { getDb } from "@/server/db";
import { errorResponse } from "@/server/http";
import { syncCatalog } from "@/server/services/seller-catalog";

export async function POST(request: Request) {
  try {
    const shop = await currentSeller();
    const body: unknown = await request.json().catch(() => null);
    return Response.json(await syncCatalog(getDb(), shop, body));
  } catch (error) {
    return errorResponse(error);
  }
}
