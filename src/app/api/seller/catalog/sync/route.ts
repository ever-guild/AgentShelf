import { currentSeller } from "@/server/auth/current-seller";
import { getDb } from "@/server/db";
import { errorResponse, readJsonWithin } from "@/server/http";
import { syncCatalog } from "@/server/services/seller-catalog";

export async function POST(request: Request) {
  try {
    const shop = await currentSeller();
    const body: unknown = await readJsonWithin(request);
    return Response.json(await syncCatalog(getDb(), shop, body));
  } catch (error) {
    return errorResponse(error);
  }
}
