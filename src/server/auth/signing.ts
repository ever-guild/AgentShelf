import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { ServiceError } from "../errors";

function signingSecret(): string {
  const secret = process.env.APP_SIGNING_SECRET;
  if (!secret || secret.length < 32) {
    throw new ServiceError(
      "SERVER_MISCONFIGURED",
      "The server is not configured correctly.",
    );
  }
  return secret;
}

// `purpose` separates uses of the one secret, so a token signed for one purpose never
// verifies for another.
export function sign(purpose: string, value: string): string {
  return createHmac("sha256", signingSecret())
    .update(`${purpose}\0${value}`)
    .digest("base64url");
}

export function verifySignature(
  purpose: string,
  value: string,
  signature: string,
): boolean {
  const expected = Buffer.from(sign(purpose, value));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
