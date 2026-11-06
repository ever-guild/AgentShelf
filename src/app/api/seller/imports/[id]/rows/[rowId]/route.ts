import { currentSeller } from "@/server/auth/current-seller";
import { getDb } from "@/server/db";
import { errorResponse } from "@/server/http";
import { updateImportRow } from "@/server/services/imports";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; rowId: string }> },
) {
  try {
    const shop = await currentSeller();
    const { id, rowId } = await params;
    const patch: unknown = await request.json().catch(() => null);
    return Response.json(await updateImportRow(getDb(), shop, id, rowId, patch));
  } catch (error) {
    return errorResponse(error);
  }
}
