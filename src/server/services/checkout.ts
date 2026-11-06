import "server-only";

import { createHash } from "node:crypto";

import type { Order } from "@paypal/paypal-server-sdk";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { z } from "zod";

import { issueOrderStatusToken } from "../auth/order-status-token";
import {
  createCheckoutInput,
  createCheckoutResult,
} from "../contracts/commerce";
import type { Db } from "../db/client";
import { orderLines, orders, shops } from "../db/schema";
import { ServiceError, parseInput } from "../errors";
import {
  buildOrderRequest,
  describePayPalFailure,
  findOrderMismatch,
  paypalOrdersFor,
  sandboxApprovalUrl,
  type PayPalOrdersProvider,
} from "../paypal/orders";
import { publicOrigin } from "../public-origin";
import { quoteCheckout, type CheckoutQuote } from "./checkout-quote";

// PayPal keeps a PayPal-Request-Id for six hours. After that, repeating one could create a second
// order instead of returning the first.
const PROVIDER_REPLAY_WINDOW_MS = 6 * 60 * 60 * 1000;

export type CheckoutDeps = { paypalOrdersFor: PayPalOrdersProvider };

type CheckoutInput = z.output<typeof createCheckoutInput>;
type CheckoutResult = z.infer<typeof createCheckoutResult>;
type OrderRow = typeof orders.$inferSelect;
type StoredOrder = { order: OrderRow; credentialRef: string };

const notConfigured = () =>
  new ServiceError("PAYMENT_NOT_CONFIGURED", "This shop cannot take payments yet.");

const declined = () =>
  new ServiceError(
    "PAYMENT_DECLINED",
    "PayPal refused to create this order, so nothing was charged. Repeating this idempotencyKey will not help.",
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
    .select({ order: orders, credentialRef: shops.paypalCredentialRef })
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
  const inserted = await db.transaction(async (tx) => {
    const [order] = await tx
      .insert(orders)
      .values({
        shopId: quote.shopId,
        kind: "purchase",
        currency: quote.currency,
        totalMinor: quote.totalMinor,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        payeeMerchantId: quote.payeeMerchantId,
      })
      .onConflictDoNothing({ target: orders.idempotencyKey })
      .returning();
    if (order) {
      await tx.insert(orderLines).values(
        quote.lines.map((line) => ({
          orderId: order.id,
          shopId: order.shopId,
          ...line,
        })),
      );
    }
    return order;
  });
  if (inserted) {
    return { order: inserted, credentialRef: quote.paypalCredentialRef };
  }

  // A concurrent request with this key committed first, and its order is the one to continue.
  const winner = await findByKey(db, input.idempotencyKey);
  if (!winner) {
    throw new Error("An order with this idempotency key was not found");
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
      await db
        .update(orders)
        .set({ paymentStatus: "failed" })
        .where(and(eq(orders.id, orderId), eq(orders.paymentStatus, "pending")));
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
  deps: CheckoutDeps,
): Promise<OrderRow> {
  const paypal = deps.paypalOrdersFor(credentialRef);
  if (!paypal) {
    throw notConfigured();
  }
  const lines = await db
    .select()
    .from(orderLines)
    .where(eq(orderLines.orderId, order.id))
    .orderBy(asc(orderLines.productId));
  const body = buildOrderRequest(order, lines, publicOrigin());

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

// The one checkout entry point, for MCP and the storefront. The agent gets a link and the buyer
// approves in PayPal, so an order stays `pending` here: only verified capture marks it paid.
export async function createCheckout(
  db: Db,
  rawInput: unknown,
  deps: CheckoutDeps = { paypalOrdersFor },
): Promise<CheckoutResult> {
  const input = parseInput(createCheckoutInput, rawInput);
  const fingerprint = fingerprintOf(input.items);

  // A repeat is answered from the stored order, whatever has since happened to prices and stock.
  let stored = await findByKey(db, input.idempotencyKey);
  if (!stored) {
    const quote = await quoteCheckout(db, input);
    if (!deps.paypalOrdersFor(quote.paypalCredentialRef)) {
      throw notConfigured();
    }
    stored = await insertOrder(db, input, fingerprint, quote);
  }
  const { order, credentialRef } = stored;

  if (order.requestFingerprint !== fingerprint) {
    throw new ServiceError(
      "IDEMPOTENCY_CONFLICT",
      "This idempotencyKey was already used for a different order. Use a new key for a new order.",
    );
  }

  // Signed before PayPal is called, so a misconfigured server cannot leave an order behind.
  const statusToken = issueOrderStatusToken(order.id);
  const toResult = (row: OrderRow) =>
    createCheckoutResult.parse({
      orderId: row.id,
      totalMinor: row.totalMinor,
      currency: row.currency,
      approvalUrl: row.approvalUrl,
      statusToken,
    });

  if (order.paymentStatus === "failed") {
    throw declined();
  }
  if (order.paymentStatus === "review_required") {
    throw needsReview();
  }
  if (order.approvalUrl) {
    return toResult(order);
  }
  if (order.paymentStatus !== "pending") {
    throw needsReview();
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

  return toResult(await requestPayPalOrder(db, order, credentialRef, deps));
}
