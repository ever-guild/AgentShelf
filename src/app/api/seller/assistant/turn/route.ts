import { connection } from "next/server";

import { createDemandAi } from "@/server/ai";
import { currentSeller } from "@/server/auth/current-seller";
import { getDb } from "@/server/db";
import { ServiceError } from "@/server/errors";
import { errorResponse, readBodyWithin } from "@/server/http";
import { runAssistantTurn } from "@/server/services/seller-assistant";

const MAX_BODY_BYTES = 512 * 1024;

// The one route that spends the model key for the assistant. The key stays here, the session decides
// the shop, and the instructions and tools are the server's.
export async function POST(request: Request) {
  await connection();
  try {
    const shop = await currentSeller();
    const body = await readBodyWithin(request, MAX_BODY_BYTES);
    if (!body) {
      throw new ServiceError("INVALID_INPUT", "The conversation is too long. Start a new one.");
    }
    const raw: unknown = JSON.parse(body.toString("utf8") || "null");
    const reply = await runAssistantTurn(getDb(), shop, raw, createDemandAi(process.env));
    return Response.json(reply, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return error instanceof SyntaxError
      ? errorResponse(new ServiceError("INVALID_INPUT", "The request is not valid JSON."))
      : errorResponse(error);
  }
}
