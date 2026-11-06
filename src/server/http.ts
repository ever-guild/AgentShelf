import "server-only";

import { ServiceError, describeForLog } from "./errors";

// Turns a thrown error into a response. Anything other than a ServiceError is logged on the
// server and returned as a generic failure, so internal detail never reaches a client.
export function errorResponse(error: unknown): Response {
  if (error instanceof ServiceError) {
    return Response.json({ error: error.toJSON() }, { status: error.httpStatus });
  }
  console.error("Request failed", describeForLog(error));
  return Response.json(
    { error: { code: "INTERNAL_ERROR", message: "Something went wrong." } },
    { status: 500 },
  );
}

// Reads a request body up to a limit, and returns undefined past it without reading the rest. A
// declared length is checked first, and the stream is counted anyway, because it can be chunked.
export async function readBodyWithin(
  request: Request,
  maxBytes: number,
): Promise<Buffer | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) {
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
    if (size > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// Room for the longest row edit a seller can send, with every character escaped.
const MAX_JSON_BODY_BYTES = 64 * 1024;

// A small JSON body for a route whose input schema decides the rest. Text that is not JSON reads as
// null, which every schema refuses.
export async function readJsonWithin(
  request: Request,
  maxBytes: number = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  const body = await readBodyWithin(request, maxBytes);
  if (!body) {
    throw new ServiceError("INVALID_INPUT", "This request is too large.");
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}
