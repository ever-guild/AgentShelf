import "server-only";

import { eq } from "drizzle-orm";
import type { z } from "zod";

import { verifyOrderStatusToken } from "../auth/order-status-token";
import { getOrderStatusInput, getOrderStatusResult } from "../contracts/commerce";
import type { Db } from "../db/client";
import { bookings, orders, shops } from "../db/schema";
import { ServiceError, parseInput } from "../errors";

// Reads the stored state only: it never asks PayPal and never changes anything. The same error
// covers a missing order and a wrong capability, so a caller cannot probe for order identifiers,
// and the capability is checked before the database is touched.
export async function getOrderStatus(
  db: Db,
  rawInput: unknown,
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
      timezone: shops.timezone,
      booking: bookings,
    })
    .from(orders)
    .innerJoin(shops, eq(orders.shopId, shops.id))
    .leftJoin(bookings, eq(bookings.orderId, orders.id))
    .where(eq(orders.id, orderId));
  if (!row) {
    throw unavailable();
  }

  return getOrderStatusResult.parse({
    orderId,
    paymentStatus: row.paymentStatus,
    totalMinor: row.totalMinor,
    currency: row.currency,
    booking: row.booking && {
      bookingId: row.booking.id,
      status: row.booking.status,
      startsAt: row.booking.startsAt.toISOString(),
      endsAt: row.booking.endsAt.toISOString(),
      expiresAt: row.booking.holdExpiresAt.toISOString(),
      timezone: row.timezone,
    },
    updatedAt: row.updatedAt.toISOString(),
  });
}
