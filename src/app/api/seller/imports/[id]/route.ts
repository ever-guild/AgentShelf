import { currentSeller } from "@/server/auth/current-seller";
import { getDb } from "@/server/db";
import { errorResponse } from "@/server/http";
import { getImport } from "@/server/services/imports";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const shop = await currentSeller();
    const { id } = await params;
    return Response.json(await getImport(getDb(), shop, id), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
