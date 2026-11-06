import "server-only";

import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { getDb } from "../db";
import { orders } from "../db/schema";
import { expireHolds } from "./bookings";
import {
  defaultReconcileDeps,
  reconcileOrder,
  type ReconcileDeps,
} from "./payment-reconciliation";

// Settles orders that neither a return nor a webhook has settled: a buyer who approved and closed
// the tab, a capture whose outcome was lost, a webhook that was never registered. It reconciles
// and nothing more, so it can never charge twice. It is bounded in both directions: each pass
// looks at a limited batch, an order is asked about less often as it ages, and after three days
// an order that is still open is closed rather than asked about forever.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const SWEEP_BATCH = 20;
const OPEN_ORDER_WINDOW = sql`interval '72 hours'`;

export async function sweepOpenOrders(
  db: Db,
  deps: ReconcileDeps = defaultReconcileDeps,
  batch = SWEEP_BATCH,
): Promise<number> {
  // Frees a technician's time. The order behind an expired hold is still asked about below, which
  // closes it, or finds a capture PayPal had already made, so that money reaches review.
  await expireHolds(db);

  // PayPal never acknowledged these, so their link never reached anyone and nobody can pay them.
  await db
    .update(orders)
    .set({ paymentStatus: "failed" })
    .where(
      and(
        eq(orders.paymentStatus, "pending"),
        isNull(orders.paypalOrderId),
        lt(orders.createdAt, sql`now() - ${OPEN_ORDER_WINDOW}`),
      ),
    );

  const due = await db
    .select({
      id: orders.id,
      closing: sql<boolean>`${orders.createdAt} < now() - ${OPEN_ORDER_WINDOW}`,
    })
    .from(orders)
    .where(
      and(
        inArray(orders.paymentStatus, ["pending", "approved"]),
        isNotNull(orders.paypalOrderId),
        // A newly created order is still in the buyer's hands.
        lt(orders.createdAt, sql`now() - interval '2 minutes'`),
        sql`(${orders.lastCheckedAt} IS NULL OR ${orders.lastCheckedAt} < now() - GREATEST(interval '5 minutes', (now() - ${orders.createdAt}) / 12))`,
      ),
    )
    .orderBy(sql`${orders.lastCheckedAt} NULLS FIRST`)
    .limit(batch);

  for (const { id, closing } of due) {
    // Checking an order is not a change to it, so its public updatedAt stays as it was.
    await db
      .update(orders)
      .set({ lastCheckedAt: sql`now()`, updatedAt: sql`${orders.updatedAt}` })
      .where(eq(orders.id, id));
    try {
      await reconcileOrder(db, id, deps);
    } catch (error) {
      console.error("Order sweep could not settle an order", {
        orderId: id,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
    if (closing) {
      await db
        .update(orders)
        .set({ paymentStatus: "cancelled" })
        .where(and(eq(orders.id, id), eq(orders.paymentStatus, "pending")));
      // Approved with no verified outcome after three days: a person has to look.
      await db
        .update(orders)
        .set({ paymentStatus: "review_required" })
        .where(and(eq(orders.id, id), eq(orders.paymentStatus, "approved")));
    }
  }
  return due.length;
}

// One timer per server process. A second process would only repeat the same safe reads.
export function startOrderSweep(): void {
  let running = false;
  setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    sweepOpenOrders(getDb())
      .catch((error: unknown) => {
        console.error("Order sweep failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      })
      .finally(() => {
        running = false;
      });
  }, SWEEP_INTERVAL_MS).unref();
}
