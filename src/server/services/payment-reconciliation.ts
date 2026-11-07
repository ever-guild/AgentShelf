import "server-only";

import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Pool } from "pg";
import type { PoolClient } from "pg";

import { verifyOrderStatusToken } from "../auth/order-status-token";
import { getOrderStatusInput } from "../contracts/commerce";
import type { Db } from "../db/client";
import { orders, shops } from "../db/schema";
import { ServiceError } from "../errors";
import {
  describePayPalFailure,
  paypalFor,
  readPayPalOrder,
  type PayPalFailure,
  type PayPalOrderReading,
  type PayPalProvider,
  type PayPalSellerApi,
} from "../paypal/orders";
import { isReadyConnectedMerchant } from "../paypal/merchant-eligibility";
import { confirmBookingPayment, gateDepositCapture, type DepositCaptureDecision } from "./bookings";
import { beginPhysicalOrderCapture, closePhysicalOrderAfterVerifiedUnpaid, rearmPhysicalOrderAfterVerifiedRefusal, settlePhysicalOrderCapture } from "../inventory/physical-orders";

// The one place that decides what a PayPal order means for a stored order. The buyer's return, a
// verified webhook and the sweep are all only reasons to ask: each calls reconcileOrder, which
// reads the truth from PayPal. So they can arrive in any order, any number of times.

type OrderRow = typeof orders.$inferSelect;

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Runs inside the transaction that marks an order paid, exactly once per order. If it throws,
// the order stays unpaid here and the next reconciliation tries again, so a hook must only make
// database changes, and must record a problem rather than throw for an order it cannot fulfil.
export type PaymentConfirmedHook = (tx: Tx, order: OrderRow) => Promise<void>;

// Physical purchase side effects share the raw PostgreSQL transaction that commits stock and
// payment status. A failed hook rolls all three back so reconciliation can retry from PayPal.
export type PhysicalPaymentConfirmedHook = (client: PoolClient, orderId: string) => Promise<void>;

// Asked before a deposit is captured, only while PayPal reports that no money has moved. It decides
// whether to capture and, when it does, has already written the order `approved` in the same
// transaction as its check.
export type DepositCaptureGate = (
  db: Db,
  order: OrderRow,
  reading: "ready_to_capture" | "awaiting_buyer",
) => Promise<DepositCaptureDecision>;

export type ReconcileDeps = {
  paypalFor: PayPalProvider;
  onPaymentConfirmed: PaymentConfirmedHook;
  onPhysicalPaymentConfirmed?: PhysicalPaymentConfirmedHook;
  gateDepositCapture: DepositCaptureGate;
};

export const defaultReconcileDeps: ReconcileDeps = {
  paypalFor,
  onPaymentConfirmed: (tx, order) => confirmBookingPayment(tx, order),
  onPhysicalPaymentConfirmed: async () => undefined,
  gateDepositCapture: (db, order, reading) => gateDepositCapture(db, order, reading),
};

const unavailable = () =>
  new ServiceError(
    "PAYMENT_UNAVAILABLE",
    "PayPal could not confirm this order right now. Nothing has changed.",
  );

function inventoryPool(db: Db): Pool {
  return (db as Db & { $client: Pool }).$client;
}

async function loadOrder(db: Db, orderId: string) {
  const [row] = await db
    .select({ order: orders, credentialRef: sql<string>`coalesce(${orders.paypalCredentialRef}, ${shops.paypalCredentialRef})` })
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
// Whatever the call reports, the answer comes from reading the order again. `refusalIsFinal` is
// false for a deposit: another reconciliation may have sent the same capture first, whichever
// attempt this one is, and what PayPal answers while that is in progress cannot be known here. So a
// refusal proves nothing, the order stays approved, and it settles once its hold has ended.
async function captureAndRead(
  paypal: PayPalSellerApi,
  order: OrderRow & { paypalOrderId: string },
  read: () => Promise<PayPalOrderReading>,
  refusalIsFinal = true,
): Promise<ReconcileReading> {
  let refused = false;
  let refusal: PayPalFailure | undefined;
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
    refusal = failure;
  }

  const reading = await read();
  if (reading.outcome !== "ready_to_capture") {
    return reading;
  }
  // Still approved. A refusal such as a declined instrument is final for this attempt, while an
  // unknown outcome stays open for the next reconciliation, which repeats the same request.
  if (refused && refusalIsFinal) {
    return {
      outcome: "capture_refused",
      retryable: refusal?.issues?.includes("INSTRUMENT_DECLINED") ?? false,
    };
  }
  throw unavailable();
}

type ReconcileReading = Exclude<PayPalOrderReading, { outcome: "capture_refused" }> | { outcome: "capture_refused"; captureId?: string; retryable?: boolean };

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
  reading: ReconcileReading,
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
      if (order.kind === "purchase") {
        const capturedAt = "capturedAt" in reading ? reading.capturedAt : undefined;
        if (!(capturedAt instanceof Date) || Number.isNaN(capturedAt.getTime())) {
          await markForReview(db, order.id, "capture timestamp", reading.captureId);
          return;
        }
        await settlePhysicalOrderCapture(inventoryPool(db), order.id, {
          captureId: reading.captureId,
          providerStatus: "COMPLETED",
          capturedAt,
          verified: true,
        }, deps.onPhysicalPaymentConfirmed);
        return;
      }
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
      if (order.kind === "purchase") {
        if (reading.retryable) {
          const disposition = await rearmPhysicalOrderAfterVerifiedRefusal(inventoryPool(db), order.id);
          if (disposition === "rearmed" || disposition === "expired") return;
        }
        await closePhysicalOrderAfterVerifiedUnpaid(
          inventoryPool(db),
          order.id,
          "verified_unpaid",
          "failed",
          true,
          new Date(),
          reading.captureId,
        );
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
      if (order.kind === "purchase") {
        await closePhysicalOrderAfterVerifiedUnpaid(
          inventoryPool(db),
          order.id,
          "verified_cancelled",
          "cancelled",
          true,
        );
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
  // that the order was not approved. A later approval still wins for a product, while a deposit's
  // time has been released by then, so it is not charged.
  buyerCancelled?: boolean;
};

// Brings a stored order in line with PayPal. Safe to call at any time and from anywhere: it only
// asks PayPal to capture an order PayPal reports as approved, which a person did in PayPal, and a
// deposit only while its hold is live.
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
  // Without a PayPal order there is nothing to ask about. A review waits for a person, except that a
  // deposit in review with no capture on record is still read, only to record a capture that lands.
  const depositReviewWithoutCapture =
    order.kind === "booking_deposit" &&
    order.paymentStatus === "review_required" &&
    !order.paypalCaptureId;
  if (
    !paypalOrderId ||
    (order.paymentStatus === "review_required" && !depositReviewWithoutCapture)
  ) {
    return order;
  }

  const paypal = deps.paypalFor(credentialRef, order.payeeMerchantId);
  if (!paypal && depositReviewWithoutCapture) {
    // Still waiting for a person, as before, with nothing it could record now.
    return order;
  }
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
  if (depositReviewWithoutCapture) {
    await recordDepositCapture(db, order.id, reading);
    return (await loadOrder(db, order.id))?.order;
  }
  if (
    order.kind !== "purchase" &&
    order.paymentStatus !== "paid" &&
    (reading.outcome === "ready_to_capture" || reading.outcome === "awaiting_buyer")
  ) {
    const gate = await deps.gateDepositCapture(db, order, reading.outcome);
    if (gate.action === "stop") {
      return (await loadOrder(db, order.id))?.order;
    }
    if (gate.action === "capture") {
      reading = await captureAndRead(paypal, { ...order, paypalOrderId }, read, false);
    }
  }
  if (order.kind === "purchase" && order.paymentStatus !== "paid") {
    if (reading.outcome === "awaiting_buyer") {
      const closed = await closePhysicalOrderAfterVerifiedUnpaid(
        inventoryPool(db),
        order.id,
        "verified_expired_unpaid",
        "cancelled",
      );
      if (closed) return (await loadOrder(db, order.id))?.order;
    }
    if (reading.outcome === "ready_to_capture") {
      if (
        credentialRef === "PAYPAL_PLATFORM" &&
        !(await isReadyConnectedMerchant(inventoryPool(db), order.shopId, order.payeeMerchantId))
      ) {
        // Revoking seller consent blocks any new capture. A prior ambiguous capture attempt keeps
        // its stock hold; only a never-started allocation can be safely released here.
        const closed = await closePhysicalOrderAfterVerifiedUnpaid(
          inventoryPool(db), order.id, "verified_unpaid", "cancelled",
        );
        if (!closed) {
          await db
            .update(orders)
            .set({ paymentStatus: "approved" })
            .where(and(eq(orders.id, order.id), inArray(orders.paymentStatus, ["pending", "cancelled", "failed"])));
        }
        return (await loadOrder(db, order.id))?.order;
      }
      const gate = await beginPhysicalOrderCapture(inventoryPool(db), order.id);
      if (!gate.allowed) {
        if (gate.reason === "expired") {
          await closePhysicalOrderAfterVerifiedUnpaid(
            inventoryPool(db),
            order.id,
            "verified_expired_unpaid",
            "cancelled",
          );
          return (await loadOrder(db, order.id))?.order;
        }
        if (gate.reason === "missing_reservation") {
          await closePhysicalOrderAfterVerifiedUnpaid(
            inventoryPool(db),
            order.id,
            "verified_unpaid",
            "cancelled",
          );
          return (await loadOrder(db, order.id))?.order;
        }
        if (gate.reason === "already_started") {
          await db
            .update(orders)
            .set({ paymentStatus: "approved" })
            .where(and(eq(orders.id, order.id), inArray(orders.paymentStatus, ["pending", "cancelled", "failed"])));
          return (await loadOrder(db, order.id))?.order;
        }
        const latest = await read();
        if (latest.outcome !== "ready_to_capture" && latest.outcome !== "awaiting_buyer") {
          await applyReading(db, order, latest, deps, options);
          return (await loadOrder(db, order.id))?.order;
        }
        if (order.paymentStatus === "pending" || order.paymentStatus === "approved") {
          await markForReview(db, order.id, "physical inventory allocation is terminal");
        }
        return (await loadOrder(db, order.id))?.order;
      }
    }
  }

  // A deposit is captured above, through its gate, and never here.
  if (reading.outcome === "ready_to_capture" && order.kind === "purchase" && order.paymentStatus !== "paid") {
    await db
      .update(orders)
      .set({ paymentStatus: "approved" })
      .where(and(eq(orders.id, order.id), inArray(orders.paymentStatus, ["pending", "cancelled", "failed"])));
    reading = await captureAndRead(paypal, { ...order, paypalOrderId }, read);
  }

  await applyReading(db, order, reading, deps, options);
  if (order.kind !== "purchase") {
    // The sweep's three-day close can send an order to review while this reconciliation is landing
    // its capture, and then the write to paid above finds nothing to change.
    await recordDepositCapture(db, order.id, reading);
  }
  return (await loadOrder(db, order.id))?.order;
}

// Records the capture PayPal reports on a deposit order in review that has none on record, so the
// money is on record for the person who looks. Nothing else changes: the order stays in review, and
// nothing is captured.
async function recordDepositCapture(
  db: Db,
  orderId: string,
  reading: ReconcileReading,
): Promise<void> {
  const captureId = "captureId" in reading ? reading.captureId : undefined;
  if (!captureId) {
    return;
  }
  await db
    .update(orders)
    .set({ paypalCaptureId: captureId })
    .where(
      and(
        eq(orders.id, orderId),
        eq(orders.paymentStatus, "review_required"),
        isNull(orders.paypalCaptureId),
      ),
    );
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
