import { currentSeller } from "@/server/auth/current-seller";
import { getDb } from "@/server/db";
import { errorResponse, readJsonWithin } from "@/server/http";
import { applyBulkAction } from "@/server/services/imports";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const shop = await currentSeller();
    const { id } = await params;
    const action: unknown = await readJsonWithin(request);
    return Response.json(await applyBulkAction(getDb(), shop, id, action));
  } catch (error) {
    return errorResponse(error);
  }
}
