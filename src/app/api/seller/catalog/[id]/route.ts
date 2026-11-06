import { currentSeller } from "@/server/auth/current-seller";
import { getDb } from "@/server/db";
import { errorResponse, readJsonWithin } from "@/server/http";
import { updateCatalogProduct } from "@/server/services/seller-catalog";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const shop = await currentSeller();
    const { id } = await params;
    const patch: unknown = await readJsonWithin(request);
    return Response.json(await updateCatalogProduct(getDb(), shop, id, patch));
  } catch (error) {
    return errorResponse(error);
  }
}
