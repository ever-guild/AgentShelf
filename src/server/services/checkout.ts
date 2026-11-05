import "server-only";

import type { z } from "zod";

import type { createCheckoutResult } from "../contracts/commerce";
import type { Db } from "../db/client";
import { ServiceError } from "../errors";
import { quoteCheckout } from "./checkout-quote";

// The one checkout entry point for MCP and the storefront. Carts are already validated against
// stored data. Creating the PayPal order is the remaining step, and until it exists this says
// so plainly rather than returning an approval link that leads nowhere.
export async function createCheckout(
  db: Db,
  rawInput: unknown,
): Promise<z.infer<typeof createCheckoutResult>> {
  await quoteCheckout(db, rawInput);
  throw new ServiceError(
    "PAYMENT_UNAVAILABLE",
    "Payment is not available yet, so no order was created and nothing was charged.",
  );
}
