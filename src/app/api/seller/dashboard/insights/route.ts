import { connection } from "next/server";

import { createDemandAi } from "@/server/ai";
import { currentSeller } from "@/server/auth/current-seller";
import { getDb } from "@/server/db";
import { errorResponse, readBodyWithin } from "@/server/http";
import { ServiceError } from "@/server/errors";
import { getDashboardInsights, writeDemandInsight } from "@/server/services/demand-insights";

import { datasetRoute } from "../dataset-route";

const MAX_BODY_BYTES = 1024;

// Polled with the other datasets. It only reads, and never calls a model.
export const GET = datasetRoute((db, shop, query) =>
  getDashboardInsights(db, shop, query, { aiAvailable: Boolean(process.env.ANTHROPIC_API_KEY) }),
);

// The seller's button. The same data never pays for a second note.
export async function POST(request: Request) {
  await connection();
  try {
    const shop = await currentSeller();
    const body = await readBodyWithin(request, MAX_BODY_BYTES);
    if (!body) {
      throw new ServiceError("INVALID_INPUT", "The request is too large.");
    }
    const raw: unknown = JSON.parse(body.toString("utf8") || "null");
    const answer = await writeDemandInsight(getDb(), shop, raw, createDemandAi(process.env));
    return Response.json(answer, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return error instanceof SyntaxError
      ? errorResponse(new ServiceError("INVALID_INPUT", "The request is not valid JSON."))
      : errorResponse(error);
  }
}
