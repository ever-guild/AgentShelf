import { currentSeller } from "@/server/auth/current-seller";
import { getDb } from "@/server/db";
import { errorResponse, readJsonWithin } from "@/server/http";
import { addTechnician } from "@/server/services/seller-technicians";

// Adds a technician to the session's shop, with an empty week. A name the shop already has is a
// 409 and adds nothing.
export async function POST(request: Request) {
  try {
    const shop = await currentSeller();
    const body: unknown = await readJsonWithin(request);
    return Response.json(await addTechnician(getDb(), shop, body), {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
