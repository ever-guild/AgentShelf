import { getDb } from "@/server/db";
import { handlePayPalWebhook } from "@/server/services/paypal-webhook";

const MAX_BODY_BYTES = 256 * 1024;

// Returns undefined if the body is over the limit, without reading the rest of it.
async function readBody(request: Request): Promise<string | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return undefined;
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.length;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const rawBody = await readBody(request);
  if (rawBody === undefined) {
    return new Response(null, { status: 413 });
  }
  const status = await handlePayPalWebhook(getDb(), {
    shopSlug: slug,
    rawBody,
    headers: request.headers,
  });
  return new Response(null, { status });
}
