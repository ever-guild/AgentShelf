import "server-only";

import { and, asc, desc, eq, gt, gte, lte, ne, notInArray, or, type SQL } from "drizzle-orm";

import type { ScheduleBooking, ScheduleView } from "../contracts/seller-schedule";
import { scheduleQuery } from "../contracts/seller-schedule";
import type { Db } from "../db/client";
import { bookings } from "../db/schema";
import {
  formatLocalDate,
  isoWeekday,
  localDateOf,
  localDateTimeString,
  localToInstant,
  nextLocalDate,
  type LocalDate,
} from "../domain/shop-time";
import { parseInput } from "../errors";
import { getShopSchedule, type BookingView } from "./booking-schedule";

// One day of a shop's schedule, for /seller/schedule and its polling route. The shop is the
// session's, so another shop's bookings cannot be named here at all.

const DEFAULT_OPEN_MINUTE = 9 * 60;
const DEFAULT_CLOSE_MINUTE = 18 * 60;
const DAY_MINUTES = 24 * 60;

function parseLocalDate(date: string): LocalDate {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

function minuteOfDay(localDateTime: string): number {
  return Number(localDateTime.slice(11, 13)) * 60 + Number(localDateTime.slice(14, 16));
}

function barEnd(startsLocal: string, endsLocal: string, elapsedMs: number): string {
  if (endsLocal > startsLocal) {
    return endsLocal;
  }
  return new Date(Date.parse(`${startsLocal}Z`) + elapsedMs).toISOString().slice(0, 19);
}

function toScheduleBooking(booking: BookingView, timezone: string): ScheduleBooking {
  const startsAt = new Date(booking.startsAt);
  const endsAt = new Date(booking.endsAt);
  const startsLocal = localDateTimeString(startsAt, timezone);
  const endsLocal = localDateTimeString(endsAt, timezone);
  return {
    bookingId: booking.bookingId,
    technicianId: booking.technicianId,
    serviceTitle: booking.serviceTitle,
    status: booking.status,
    reviewReason: booking.reviewReason,
    paymentStatus: booking.paymentStatus,
    startsLocal,
    endsLocal,
    barEndLocal: barEnd(startsLocal, endsLocal, endsAt.getTime() - startsAt.getTime()),
    holdExpiresAt: booking.holdExpiresAt,
    holdExpiresLocal: localDateTimeString(new Date(booking.holdExpiresAt), timezone),
    depositMinor: booking.depositMinor,
    remainingMinor: booking.remainingMinor,
    currency: booking.currency,
  };
}

// Whole hours around the day's working time and whatever is booked, so nothing sits off the axis.
function timelineHours(
  date: string,
  windows: { startMinute: number; endMinute: number }[],
  dayBookings: ScheduleBooking[],
): { start: string; end: string } {
  const open = Math.min(
    DEFAULT_OPEN_MINUTE,
    ...windows.map((window) => window.startMinute),
    ...dayBookings.map(({ startsLocal }) =>
      startsLocal.slice(0, 10) < date ? 0 : minuteOfDay(startsLocal),
    ),
  );
  const close = Math.max(
    DEFAULT_CLOSE_MINUTE,
    ...windows.map((window) => window.endMinute),
    ...dayBookings.map(({ barEndLocal }) =>
      barEndLocal.slice(0, 10) > date ? DAY_MINUTES : minuteOfDay(barEndLocal),
    ),
  );
  const atHour = (hour: number) => `${date}T${String(hour).padStart(2, "0")}:00:00`;
  const endHour = Math.ceil(close / 60);
  return {
    start: atHour(Math.floor(open / 60)),
    end:
      endHour >= 24
        ? `${formatLocalDate(nextLocalDate(parseLocalDate(date)))}T00:00:00`
        : atHour(endHour),
  };
}

// A booking worth jumping to: a hold still running, a confirmed appointment or one needing review.
function nearestBooking(db: Db, shopId: string, now: Date, range: SQL) {
  return db
    .select({ startsAt: bookings.startsAt })
    .from(bookings)
    .where(
      and(
        eq(bookings.shopId, shopId),
        range,
        notInArray(bookings.status, ["expired", "cancelled"]),
        or(ne(bookings.status, "held"), gt(bookings.holdExpiresAt, now)),
      ),
    )
    .limit(1);
}

export async function getSellerSchedule(
  db: Db,
  shop: { id: string; timezone: string },
  rawQuery: unknown,
  now: Date = new Date(),
): Promise<ScheduleView> {
  const query = parseInput(scheduleQuery, rawQuery);
  const { timezone } = shop;
  const today = formatLocalDate(localDateOf(now, timezone));
  const date = query.date ?? today;
  const localDate = parseLocalDate(date);
  const from = localToInstant(localDate, 0, timezone);
  const to = localToInstant(nextLocalDate(localDate), 0, timezone);

  const [schedule, [previous], [next]] = await Promise.all([
    getShopSchedule(db, shop.id, from, to, now),
    nearestBooking(db, shop.id, now, lte(bookings.endsAt, from)).orderBy(desc(bookings.startsAt)),
    nearestBooking(db, shop.id, now, gte(bookings.startsAt, to)).orderBy(asc(bookings.startsAt)),
  ]);

  const dayBookings = schedule.bookings.map((booking) => toScheduleBooking(booking, timezone));
  const weekday = isoWeekday(localDate);
  const timeline = timelineHours(
    date,
    schedule.technicians.flatMap(({ windows }) =>
      windows.filter((window) => window.weekday === weekday),
    ),
    dayBookings,
  );

  return {
    shopId: shop.id,
    timezone,
    generatedAt: now.toISOString(),
    date,
    today,
    timelineStart: timeline.start,
    timelineEnd: timeline.end,
    previousBookingDate: previous
      ? formatLocalDate(localDateOf(previous.startsAt, timezone))
      : null,
    nextBookingDate: next ? formatLocalDate(localDateOf(next.startsAt, timezone)) : null,
    technicians: schedule.technicians.map(({ technicianId, name }) => ({ technicianId, name })),
    bookings: dayBookings,
  };
}
