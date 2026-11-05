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
