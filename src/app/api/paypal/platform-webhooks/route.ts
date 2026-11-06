import { getDb } from "@/server/db";
import { readBodyWithin } from "@/server/http";
import { handlePlatformPayPalWebhook } from "@/server/services/paypal-webhook";

const MAX_BODY_BYTES = 256 * 1024;

export async function POST(request: Request): Promise<Response> {
  const body = await readBodyWithin(request, MAX_BODY_BYTES);
  if (body === undefined) return new Response(null, { status: 413 });
  const status = await handlePlatformPayPalWebhook(getDb(), {
    rawBody: body.toString("utf8"),
    headers: request.headers,
  });
  return new Response(null, { status });
}
