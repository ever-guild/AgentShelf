import "server-only";

import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { verifyOrderStatusToken } from "../auth/order-status-token";
import { getOrderStatusInput } from "../contracts/commerce";
import type { Db } from "../db/client";
import { orders, shops } from "../db/schema";
import { ServiceError } from "../errors";
import {
  describePayPalFailure,
  paypalFor,
  readPayPalOrder,
  type PayPalOrderReading,
  type PayPalProvider,
  type PayPalSellerApi,
} from "../paypal/orders";

// The one place that decides what a PayPal order means for a stored order. The buyer's return, a
// verified webhook and the sweep are all only reasons to ask: each calls reconcileOrder, which
// reads the truth from PayPal. So they can arrive in any order, any number of times.

type OrderRow = typeof orders.$inferSelect;

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Runs inside the transaction that marks an order paid, exactly once per order. If it throws,
// the order stays unpaid here and the next reconciliation tries again, so a hook must only make
// database changes, and must record a problem rather than throw for an order it cannot fulfil.
export type PaymentConfirmedHook = (tx: Tx, order: OrderRow) => Promise<void>;

export type ReconcileDeps = {
  paypalFor: PayPalProvider;
  onPaymentConfirmed: PaymentConfirmedHook;
};

export const defaultReconcileDeps: ReconcileDeps = {
  paypalFor,
  onPaymentConfirmed: async () => {},
};

const unavailable = () =>
  new ServiceError(
    "PAYMENT_UNAVAILABLE",
    "PayPal could not confirm this order right now. Nothing has changed.",
  );

async function loadOrder(db: Db, orderId: string) {
  const [row] = await db
    .select({ order: orders, credentialRef: shops.paypalCredentialRef })
    .from(orders)
    .innerJoin(shops, eq(orders.shopId, shops.id))
    .where(eq(orders.id, orderId));
  return row;
}

async function askPayPal<T>(
  orderId: string,
  action: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (thrown) {
    console.error("PayPal call failed", {
      orderId,
      action,
      ...describePayPalFailure(thrown),
    });
    throw unavailable();
  }
}

// Called only when PayPal has just said the order is approved. The request ID is fixed per order,
// so a repeat returns the first result, and PayPal allows one capture per order in any case.
// Whatever the call reports, the answer comes from reading the order again.
async function captureAndRead(
  paypal: PayPalSellerApi,
  order: OrderRow & { paypalOrderId: string },
  read: () => Promise<PayPalOrderReading>,
): Promise<PayPalOrderReading> {
  let refused = false;
  try {
    await paypal.captureOrder({
      id: order.paypalOrderId,
      paypalRequestId: `capture-${order.id}`,
      body: {},
    });
  } catch (thrown) {
    const failure = describePayPalFailure(thrown);
    console.error("PayPal capture failed", { orderId: order.id, ...failure });
    refused = failure.kind === "rejected";
  }

  const reading = await read();
  if (reading.outcome !== "ready_to_capture") {
    return reading;
  }
  // Still approved. A refusal such as a declined instrument is final for this attempt, while an
  // unknown outcome stays open for the next reconciliation, which repeats the same request.
  if (refused) {
    return { outcome: "capture_refused" };
  }
  throw unavailable();
}

async function markForReview(
  db: Db,
  orderId: string,
  reason: string,
  captureId?: string,
): Promise<void> {
  console.error("Order needs review", { orderId, reason });
  await db
    .update(orders)
    .set({
      paymentStatus: "review_required",
      ...(captureId
        ? { paypalCaptureId: sql`coalesce(${orders.paypalCaptureId}, ${captureId})` }
        : {}),
    })
    .where(and(eq(orders.id, orderId), ne(orders.paymentStatus, "review_required")));
}

async function applyReading(
  db: Db,
  order: OrderRow,
  reading: PayPalOrderReading,
  deps: ReconcileDeps,
  options: ReconcileOptions,
): Promise<void> {
  const unpaid = ["pending", "approved", "cancelled", "failed"] as const;
  const isPaid = order.paymentStatus === "paid";

  const captureId = "captureId" in reading ? reading.captureId : undefined;
  if (captureId && order.paypalCaptureId && captureId !== order.paypalCaptureId) {
    await markForReview(db, order.id, "a different capture");
    return;
  }

  switch (reading.outcome) {
    case "awaiting_buyer":
      if (options.buyerCancelled) {
        await db
          .update(orders)
          .set({ paymentStatus: "cancelled" })
          .where(and(eq(orders.id, order.id), eq(orders.paymentStatus, "pending")));
      }
      return;

    case "ready_to_capture":
      // Reached only for an order already paid here, which is never captured again.
      return;

    case "capture_pending":
      await db
        .update(orders)
        .set({ paymentStatus: "approved", paypalCaptureId: reading.captureId })
        .where(and(eq(orders.id, order.id), inArray(orders.paymentStatus, unpaid)));
      return;

    case "paid":
      // The status check makes this the one write that can take the order to paid, however many
      // reconciliations race, so the hook runs once.
      await db.transaction(async (tx) => {
        const [paid] = await tx
          .update(orders)
          .set({ paymentStatus: "paid", paypalCaptureId: reading.captureId })
          .where(and(eq(orders.id, order.id), inArray(orders.paymentStatus, unpaid)))
          .returning();
        if (paid) {
          await deps.onPaymentConfirmed(tx, paid);
        }
      });
      return;

    case "capture_refused":
      if (isPaid) {
        await markForReview(db, order.id, "paid order with a refused capture");
        return;
      }
      await db
        .update(orders)
        .set({
          paymentStatus: "failed",
          ...(reading.captureId ? { paypalCaptureId: reading.captureId } : {}),
        })
        .where(and(eq(orders.id, order.id), inArray(orders.paymentStatus, unpaid)));
      return;

    case "voided":
      if (isPaid) {
        await markForReview(db, order.id, "paid order that was voided");
        return;
      }
      await db
        .update(orders)
        .set({ paymentStatus: "cancelled" })
        .where(and(eq(orders.id, order.id), inArray(orders.paymentStatus, unpaid)));
      return;

    case "needs_review":
      await markForReview(db, order.id, reading.reason, reading.captureId);
      return;
  }
}

export type ReconcileOptions = {
  // The buyer came back from PayPal through the cancel link. This counts only if PayPal agrees
  // that the order was not approved, and a later approval still wins.
  buyerCancelled?: boolean;
};

// Brings a stored order in line with PayPal. Safe to call at any time and from anywhere: it only
// asks PayPal to capture an order PayPal reports as approved, which a person did in PayPal.
// Throws a ServiceError if the outcome stays unknown, and the order then keeps its state.
export async function reconcileOrder(
  db: Db,
  orderId: string,
  deps: ReconcileDeps = defaultReconcileDeps,
  options: ReconcileOptions = {},
): Promise<OrderRow | undefined> {
  const stored = await loadOrder(db, orderId);
  if (!stored) {
    return undefined;
  }
  const { order, credentialRef } = stored;
  const { paypalOrderId } = order;
  // Without a PayPal order there is nothing to ask about. A review waits for a person.
  if (!paypalOrderId || order.paymentStatus === "review_required") {
    return order;
  }

  const paypal = deps.paypalFor(credentialRef);
  if (!paypal) {
    throw new ServiceError(
      "PAYMENT_NOT_CONFIGURED",
      "This shop cannot take payments yet.",
    );
  }

  const read = () =>
    askPayPal(order.id, "read", async () => {
      const { result } = await paypal.getOrder({ id: paypalOrderId });
      return readPayPalOrder(result, order);
    });

  let reading = await read();
  if (reading.outcome === "ready_to_capture" && order.paymentStatus !== "paid") {
    await db
      .update(orders)
      .set({ paymentStatus: "approved" })
      .where(
        and(
          eq(orders.id, order.id),
          inArray(orders.paymentStatus, ["pending", "cancelled", "failed"]),
        ),
      );
    reading = await captureAndRead(paypal, { ...order, paypalOrderId }, read);
  }

  await applyReading(db, order, reading, deps, options);
  return (await loadOrder(db, order.id))?.order;
}

// Handles the buyer coming back from PayPal. The capability is what authorizes this, so an order
// identifier alone does nothing. Returns whether the capability was valid. A failure to reach
// PayPal is not the buyer's problem: the order keeps its state, and the sweep or a webhook settles
// it later.
export async function reconcileForBuyer(
  db: Db,
  rawInput: unknown,
  deps: ReconcileDeps = defaultReconcileDeps,
  options: ReconcileOptions = {},
): Promise<boolean> {
  const input = getOrderStatusInput.safeParse(rawInput);
  if (
    !input.success ||
    !verifyOrderStatusToken(input.data.orderId, input.data.statusToken)
  ) {
    return false;
  }
  try {
    await reconcileOrder(db, input.data.orderId, deps, options);
  } catch (error) {
    if (!(error instanceof ServiceError)) {
      throw error;
    }
  }
  return true;
}
