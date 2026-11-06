import { currentSeller } from "@/server/auth/current-seller";
import { getDb } from "@/server/db";
import { errorResponse } from "@/server/http";
import { finishImportReview } from "@/server/services/imports";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const shop = await currentSeller();
    const { id } = await params;
    return Response.json(await finishImportReview(getDb(), shop, id));
  } catch (error) {
    return errorResponse(error);
  }
}
