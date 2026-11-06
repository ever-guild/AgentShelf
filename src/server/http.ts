import "server-only";

import { ServiceError } from "./errors";

// Turns a thrown error into a response. Anything other than a ServiceError is logged on the
// server and returned as a generic failure, so internal detail never reaches a client.
export function errorResponse(error: unknown): Response {
  if (error instanceof ServiceError) {
    return Response.json({ error: error.toJSON() }, { status: error.httpStatus });
  }
  console.error(error);
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
