import "server-only";

import { eq } from "drizzle-orm";
import type { z } from "zod";

import { verifyOrderStatusToken } from "../auth/order-status-token";
import { getOrderStatusInput, getOrderStatusResult } from "../contracts/commerce";
import type { Db } from "../db/client";
import { orders } from "../db/schema";
import { ServiceError, parseInput } from "../errors";
import { getOrderBooking } from "./booking-schedule";

// Reads the stored state only: it never asks PayPal and never changes anything. The same error
// covers a missing order and a wrong capability, so a caller cannot probe for order identifiers,
// and the capability is checked before the database is touched.
export async function getOrderStatus(
  db: Db,
  rawInput: unknown,
  now: Date = new Date(),
): Promise<z.infer<typeof getOrderStatusResult>> {
  const { orderId, statusToken } = parseInput(getOrderStatusInput, rawInput);
  const unavailable = () =>
    new ServiceError(
      "ORDER_STATUS_UNAVAILABLE",
      "This order is not available with that status token.",
    );

  if (!verifyOrderStatusToken(orderId, statusToken)) {
    throw unavailable();
  }

  const [row] = await db
    .select({
      paymentStatus: orders.paymentStatus,
      totalMinor: orders.totalMinor,
      currency: orders.currency,
      updatedAt: orders.updatedAt,
    })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!row) {
    throw unavailable();
  }
  const booking = await getOrderBooking(db, orderId, now);

  return getOrderStatusResult.parse({
    orderId,
    paymentStatus: row.paymentStatus,
    totalMinor: row.totalMinor,
    currency: row.currency,
    // Explicit fields, because the shared view holds what only a seller may see.
    booking: booking && {
      bookingId: booking.bookingId,
      status: booking.status,
      reviewReason: booking.reviewReason,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      expiresAt: booking.holdExpiresAt,
      timezone: booking.timezone,
      depositMinor: booking.depositMinor,
      remainingMinor: booking.remainingMinor,
    },
    updatedAt: row.updatedAt.toISOString(),
  });
}
