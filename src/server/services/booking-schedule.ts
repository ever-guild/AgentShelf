import "server-only";

import { and, asc, eq, gt, lt } from "drizzle-orm";

import type { Db } from "../db/client";
import {
  bookings,
  orders,
  products,
  shops,
  technicians,
  technicianWindows,
} from "../db/schema";
import { ServiceError } from "../errors";

// The one read of bookings, for the scheduler, the dashboard and get_order_status. Nothing here
// changes anything, and there is no buyer data in a booking to leak. A caller must already know
// the shop is theirs: a seller route takes it from the session, never from the request.

type BookingStatus = (typeof bookings.$inferSelect)["status"];

const MAX_SCHEDULE_RANGE_MS = 93 * 24 * 60 * 60 * 1000;

export type BookingView = {
  bookingId: string;
  orderId: string;
  // A hold past its expiry reads as expired from that moment, however long the sweep takes to get
  // to it, so the answer does not depend on when the sweep last ran.
  status: BookingStatus;
  // Set when status is review_required: the money arrived, and a person has to refund or rebook.
  reviewReason: "late_capture" | "captured_after_cancel" | null;
  // True while this keeps the technician's time from anyone else.
  blocksTime: boolean;
  serviceId: string;
  serviceTitle: string;
  technicianId: string;
  technicianName: string;
  startsAt: string;
  endsAt: string;
  holdExpiresAt: string;
  timezone: string;
  paymentStatus: (typeof orders.$inferSelect)["paymentStatus"];
  priceMinor: number;
  depositMinor: number;
  remainingMinor: number;
  currency: string;
  // Seller-side only. get_order_status does not return it.
  depositCaptureId: string | null;
  updatedAt: string;
};

export type ShopSchedule = {
  shopId: string;
  timezone: string;
  currency: string;
  from: string;
  to: string;
  // Every technician, including those with nothing booked in the range. Windows are the weekly
  // pattern in shop time: an ISO weekday, and minutes from local midnight.
  technicians: {
    technicianId: string;
    name: string;
    windows: { weekday: number; startMinute: number; endMinute: number }[];
  }[];
  // Every booking that touches the range, in every state, by start time. A view that only wants
  // what occupies the calendar filters on blocksTime, and review_required must stay visible.
  bookings: BookingView[];
};

const bookingViewColumns = {
  bookingId: bookings.id,
  orderId: bookings.orderId,
  storedStatus: bookings.status,
  reviewReason: bookings.reviewReason,
  serviceId: bookings.serviceId,
  serviceTitle: products.title,
  technicianId: bookings.technicianId,
  technicianName: technicians.name,
  startsAt: bookings.startsAt,
  endsAt: bookings.endsAt,
  holdExpiresAt: bookings.holdExpiresAt,
  timezone: shops.timezone,
  paymentStatus: orders.paymentStatus,
  priceMinor: bookings.servicePriceMinor,
  depositMinor: orders.totalMinor,
  currency: orders.currency,
  depositCaptureId: bookings.depositCaptureId,
  updatedAt: bookings.updatedAt,
};

function bookingViews(db: Db) {
  return db
    .select(bookingViewColumns)
    .from(bookings)
    .innerJoin(orders, eq(bookings.orderId, orders.id))
    .innerJoin(shops, eq(bookings.shopId, shops.id))
    .innerJoin(products, eq(bookings.serviceId, products.id))
    .innerJoin(technicians, eq(bookings.technicianId, technicians.id));
}

type BookingRow = Awaited<ReturnType<typeof bookingViews>>[number];

export function isHoldLive(holdExpiresAt: Date, now: Date): boolean {
  return holdExpiresAt.getTime() > now.getTime();
}

function toView(
  { storedStatus, startsAt, endsAt, holdExpiresAt, updatedAt, ...row }: BookingRow,
  now: Date,
): BookingView {
  const status =
    storedStatus === "held" && !isHoldLive(holdExpiresAt, now)
      ? "expired"
      : storedStatus;
  return {
    ...row,
    status,
    blocksTime: status === "held" || status === "confirmed",
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    holdExpiresAt: holdExpiresAt.toISOString(),
    remainingMinor: row.priceMinor - row.depositMinor,
    updatedAt: updatedAt.toISOString(),
  };
}

export async function getOrderBooking(
  db: Db,
  orderId: string,
  now: Date = new Date(),
): Promise<BookingView | null> {
  const [row] = await bookingViews(db).where(eq(bookings.orderId, orderId));
  return row ? toView(row, now) : null;
}

export async function getShopSchedule(
  db: Db,
  shopId: string,
  from: Date,
  to: Date,
  now: Date = new Date(),
): Promise<ShopSchedule> {
  const span = to.getTime() - from.getTime();
  if (!(span > 0 && span <= MAX_SCHEDULE_RANGE_MS)) {
    throw new ServiceError(
      "INVALID_INPUT",
      "Choose a schedule range of up to 93 days that ends after it starts.",
    );
  }

  const [shop] = await db
    .select({ timezone: shops.timezone, currency: shops.currency })
    .from(shops)
    .where(eq(shops.id, shopId));
  if (!shop) {
    throw new ServiceError("SHOP_NOT_FOUND", "This shop does not exist.");
  }

  const [staff, windows, rows] = await Promise.all([
    db
      .select({ technicianId: technicians.id, name: technicians.name })
      .from(technicians)
      .where(eq(technicians.shopId, shopId))
      .orderBy(asc(technicians.name), asc(technicians.id)),
    db
      .select({
        technicianId: technicianWindows.technicianId,
        weekday: technicianWindows.weekday,
        startMinute: technicianWindows.startMinute,
        endMinute: technicianWindows.endMinute,
      })
      .from(technicianWindows)
      .where(eq(technicianWindows.shopId, shopId))
      .orderBy(asc(technicianWindows.weekday), asc(technicianWindows.startMinute)),
    bookingViews(db)
      .where(
        and(
          eq(bookings.shopId, shopId),
          lt(bookings.startsAt, to),
          gt(bookings.endsAt, from),
        ),
      )
      .orderBy(asc(bookings.startsAt), asc(bookings.id)),
  ]);

  return {
    shopId,
    timezone: shop.timezone,
    currency: shop.currency,
    from: from.toISOString(),
    to: to.toISOString(),
    technicians: staff.map((person) => ({
      ...person,
      windows: windows
        .filter((window) => window.technicianId === person.technicianId)
        .map(({ weekday, startMinute, endMinute }) => ({
          weekday,
          startMinute,
          endMinute,
        })),
    })),
    bookings: rows.map((row) => toView(row, now)),
  };
}
