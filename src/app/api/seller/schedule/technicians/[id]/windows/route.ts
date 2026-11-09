import { currentSeller } from "@/server/auth/current-seller";
import { getDb } from "@/server/db";
import { errorResponse, readJsonWithin } from "@/server/http";
import { setTechnicianWeek } from "@/server/services/seller-technicians";

// Replaces one technician's weekly working windows, in shop time. Another shop's technician is a
// 404, the same as one that does not exist.
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const shop = await currentSeller();
    const { id } = await params;
    const body: unknown = await readJsonWithin(request);
    return Response.json(await setTechnicianWeek(getDb(), shop, id, body), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
