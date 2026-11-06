import "server-only";

import { createHash } from "node:crypto";

import type { Order } from "@paypal/paypal-server-sdk";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Pool } from "pg";
import type { z } from "zod";

import { issueOrderStatusToken } from "../auth/order-status-token";
import {
  createCheckoutInput,
  createCheckoutResult,
} from "../contracts/commerce";
import type { Db } from "../db/client";
import { orderLines, orders, shops } from "../db/schema";
import { BOOKING_POLICY } from "../domain/booking-policy";
import { ServiceError, parseInput } from "../errors";
import {
  buildOrderRequest,
  describePayPalFailure,
  findOrderMismatch,
  paypalFor,
  sandboxApprovalUrl,
  type PayPalProvider,
} from "../paypal/orders";
import { publicOrigin } from "../public-origin";
import { quoteCheckout, type CheckoutQuote } from "./checkout-quote";
import { assertPhysicalOrderAllocationLive, closePhysicalOrderAfterVerifiedUnpaid, createReservedPhysicalOrder } from "../inventory/physical-orders";
import { InventoryError } from "../inventory/postgres";

// PayPal keeps a PayPal-Request-Id for six hours. After that, repeating one could create a second
// order instead of returning the first.
const PROVIDER_REPLAY_WINDOW_MS = 6 * 60 * 60 * 1000;

export type CheckoutDeps = { paypalFor: PayPalProvider };

type CheckoutInput = z.output<typeof createCheckoutInput>;
type CheckoutResult = z.infer<typeof createCheckoutResult>;
type OrderRow = typeof orders.$inferSelect;
export type StoredOrder = { order: OrderRow; credentialRef: string };

export const notConfigured = () =>
  new ServiceError("PAYMENT_NOT_CONFIGURED", "This shop cannot take payments yet.");

const declined = () =>
  new ServiceError(
    "PAYMENT_DECLINED",
    "PayPal did not accept this order, so nothing was charged. Repeating this idempotencyKey will not help.",
  );

const needsReview = () =>
  new ServiceError(
    "CHECKOUT_NEEDS_REVIEW",
    "This checkout needs review and has no usable approval link. A buyer who has not paid can start a new checkout with a new idempotencyKey.",
  );

function fingerprintOf(items: CheckoutInput["items"]): string {
  const normalized = items
    .map((item) => [item.productId, item.quantity] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function findByKey(
  db: Db,
  idempotencyKey: string,
): Promise<StoredOrder | undefined> {
  const [row] = await db
    .select({ order: orders, credentialRef: sql<string>`coalesce(${orders.paypalCredentialRef}, ${shops.paypalCredentialRef})` })
    .from(orders)
    .innerJoin(shops, eq(orders.shopId, shops.id))
    .where(eq(orders.idempotencyKey, idempotencyKey));
  return row;
}

// Fixes what this order charges and to whom before PayPal hears about it, so a retry can only
// ever repeat the same order.
async function insertOrder(
  db: Db,
  input: CheckoutInput,
  fingerprint: string,
  quote: CheckoutQuote,
): Promise<StoredOrder> {
  const pool = (db as Db & { $client: Pool }).$client;
  try {
    await createReservedPhysicalOrder(pool, {
      quote,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
      expiresAt: new Date(Date.now() + BOOKING_POLICY.holdMinutes * 60_000),
    });
  } catch (error) {
    if (!(error instanceof InventoryError)) throw error;
    if (error.code === "CONFLICT") {
      const winner = await findByKey(db, input.idempotencyKey);
      if (winner) {
        if (winner.order.requestFingerprint !== fingerprint) {
          throw new ServiceError("IDEMPOTENCY_CONFLICT", "This idempotencyKey was already used for a different order. Use a new key for a new order.");
        }
        return winner;
      }
      throw new ServiceError("PRODUCT_UNAVAILABLE", "A product in this order is not currently available.");
    }
    if (error.code === "INSUFFICIENT") {
      throw new ServiceError("PRODUCT_UNAVAILABLE", "A product in this order is not currently available.");
    }
    if (error.code === "REVIEW_REQUIRED") throw needsReview();
    throw error;
  }
  const winner = await findByKey(db, input.idempotencyKey);
  if (!winner) {
    throw new Error("The reserved physical order was not found after its transaction");
  }
  return winner;
}

async function markForReview(
  db: Db,
  orderId: string,
  paypalOrderId?: string,
): Promise<void> {
  await db
    .update(orders)
    .set({
      paymentStatus: "review_required",
      ...(paypalOrderId
        ? { paypalOrderId: sql`coalesce(${orders.paypalOrderId}, ${paypalOrderId})` }
        : {}),
    })
    .where(and(eq(orders.id, orderId), eq(orders.paymentStatus, "pending")));
}

async function failureToError(
  db: Db,
  orderId: string,
  thrown: unknown,
): Promise<ServiceError> {
  const failure = describePayPalFailure(thrown);
  console.error("PayPal order creation failed", { orderId, ...failure });

  switch (failure.kind) {
    case "rejected":
      if (!(await closePhysicalOrderAfterVerifiedUnpaid(
        (db as Db & { $client: Pool }).$client,
        orderId,
        "verified_unpaid",
        "failed",
      ))) {
        await db
          .update(orders)
          .set({ paymentStatus: "failed" })
          .where(and(eq(orders.id, orderId), eq(orders.paymentStatus, "pending")));
      }
      return declined();
    case "not_authorized":
      return notConfigured();
    case "timeout":
      return new ServiceError(
        "PAYMENT_TIMEOUT",
        "PayPal did not answer in time, so no approval link is available yet. Retry with the same idempotencyKey: it cannot create a second order.",
      );
    case "unavailable":
      return new ServiceError(
        "PAYMENT_UNAVAILABLE",
        "PayPal could not create this order right now, and nothing was charged. Retry shortly with the same idempotencyKey: it cannot create a second order.",
      );
  }
}

async function requestPayPalOrder(
  db: Db,
  order: OrderRow,
  credentialRef: string,
  statusToken: string,
  deps: CheckoutDeps,
): Promise<OrderRow> {
  const paypal = deps.paypalFor(credentialRef, order.payeeMerchantId);
  if (!paypal) {
    throw notConfigured();
  }
  const lines = await db
    .select()
    .from(orderLines)
    .where(eq(orderLines.orderId, order.id))
    .orderBy(asc(orderLines.productId));
  // The capability is in these links so that a person coming back from PayPal can see their own
  // order, and nobody else can by knowing an identifier.
  const origin = publicOrigin();
  const capability = new URLSearchParams({ order: order.id, status: statusToken });
  const body = buildOrderRequest(order, lines, {
    returnUrl: `${origin}/checkout/return?${capability}`,
    cancelUrl: `${origin}/checkout/cancel?${capability}`,
  });

  let created: Order;
  try {
    const response = await paypal.createOrder({
      body,
      paypalRequestId: order.id,
      prefer: "return=representation",
    });
    created = response.result;
  } catch (thrown) {
    throw await failureToError(db, order.id, thrown);
  }

  const mismatch = findOrderMismatch(created, order);
  const approvalUrl = mismatch ? undefined : sandboxApprovalUrl(created);
  if (approvalUrl) {
    const [stored] = await db
      .update(orders)
      .set({ paypalOrderId: created.id, approvalUrl })
      .where(
        and(
          eq(orders.id, order.id),
          eq(orders.paymentStatus, "pending"),
          isNull(orders.paypalOrderId),
        ),
      )
      .returning();
    if (stored) {
      return stored;
    }
  }

  // A concurrent retry of this order may have stored the same PayPal order first, and by now
  // PayPal may report it as approved. Anything else is not the order that was asked for.
  const [current] = await db.select().from(orders).where(eq(orders.id, order.id));
  if (!mismatch && current?.paypalOrderId === created.id && current.approvalUrl) {
    return current;
  }
  console.error("PayPal order needs review", {
    orderId: order.id,
    reason: mismatch ?? "approval link",
  });
  await markForReview(db, order.id, created.id);
  throw needsReview();
}

// Brings a stored order to the point where it has an approval link, or says why it cannot. Shared by
// checkout and booking, so both make the same PayPal request and answer failures the same way.
export async function ensureApprovalLink(
  db: Db,
  { order, credentialRef }: StoredOrder,
  statusToken: string,
  deps: CheckoutDeps,
): Promise<OrderRow> {
  if (order.paymentStatus === "failed") {
    throw declined();
  }
  if (order.paymentStatus === "review_required") {
    throw needsReview();
  }
  if (order.kind !== "purchase" && order.approvalUrl) {
    return order;
  }
  if (order.paymentStatus !== "pending") {
    throw needsReview();
  }
  if (order.approvalUrl) {
    return order;
  }
  if (Date.now() - order.createdAt.getTime() >= PROVIDER_REPLAY_WINDOW_MS) {
    // The first attempt's outcome was never learned, but its link never reached anyone, so
    // nobody can pay that order. A new key cannot lead to two payments.
    console.error("PayPal order needs review", {
      orderId: order.id,
      reason: "retry window passed",
    });
    await markForReview(db, order.id);
    throw needsReview();
  }
  return requestPayPalOrder(db, order, credentialRef, statusToken, deps);
}

// The one checkout entry point, for MCP and the storefront. The agent gets a link and the buyer
// approves in PayPal, so an order stays `pending` here: only verified capture marks it paid.
export async function createCheckout(
  db: Db,
  rawInput: unknown,
  deps: CheckoutDeps = { paypalFor },
): Promise<CheckoutResult> {
  const input = parseInput(createCheckoutInput, rawInput);
  const fingerprint = fingerprintOf(input.items);

  // A repeat is answered from the stored order, whatever has since happened to prices and stock.
  let stored = await findByKey(db, input.idempotencyKey);
  if (!stored) {
    const quote = await quoteCheckout(db, input);
    if (!deps.paypalFor(quote.paypalCredentialRef, quote.payeeMerchantId)) {
      throw notConfigured();
    }
    stored = await insertOrder(db, input, fingerprint, quote);
  }
  const { order } = stored;

  if (order.requestFingerprint !== fingerprint) {
    throw new ServiceError(
      "IDEMPOTENCY_CONFLICT",
      "This idempotencyKey was already used for a different order. Use a new key for a new order.",
    );
  }

  if (order.kind === "purchase" && order.paymentStatus === "pending") {
    try {
      await assertPhysicalOrderAllocationLive(
        (db as Db & { $client: Pool }).$client,
        order.id,
      );
    } catch (error) {
      if (error instanceof InventoryError) throw needsReview();
      throw error;
    }
  }

  // Signed before PayPal is called, so a misconfigured server cannot leave an order behind.
  const statusToken = issueOrderStatusToken(order.id);
  const row = await ensureApprovalLink(db, stored, statusToken, deps);
  return createCheckoutResult.parse({
    orderId: row.id,
    totalMinor: row.totalMinor,
    currency: row.currency,
    approvalUrl: row.approvalUrl,
    statusToken,
  });
}
