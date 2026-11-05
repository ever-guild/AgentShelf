import "server-only";

import { sign, verifySignature } from "./signing";

// The capability that get_order_status requires. It is derived rather than stored, so an
// idempotent retry of create_checkout returns the same token and a database read does not
// reveal any tokens.
const PURPOSE = "order-status:v1";

export function issueOrderStatusToken(orderId: string): string {
  return sign(PURPOSE, orderId);
}

export function verifyOrderStatusToken(orderId: string, token: string): boolean {
  return verifySignature(PURPOSE, orderId, token);
}
