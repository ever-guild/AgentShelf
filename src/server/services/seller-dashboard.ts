import "server-only";

import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";

import {
  DEFAULT_DASHBOARD_PERIOD,
  dashboardQuery,
  paymentGroupOf,
  type DashboardBooking,
  type DashboardBookings,
  type DashboardCapture,
  type DashboardDemand,
  type DashboardDemandRow,
  type DashboardOrder,
  type DashboardOrders,
  type DashboardPaymentTotal,
  type DashboardPayments,
} from "../contracts/seller-dashboard";
import type { Db } from "../db/client";
import { bookings, orderLines, orders, products, searchEvents } from "../db/schema";
import {
  formatLocalDate,
  localDateOf,
  localDateTimeString,
  localToInstant,
  type LocalDate,
} from "../domain/shop-time";
import { parseInput } from "../errors";
import { getShopSchedule } from "./booking-schedule";

// The four datasets behind /seller/dashboard. The caller passes the session's shop, every query is
// scoped to it, and each result lists its columns, so a new column stays private until someone adds
// it here. No merchant, approval link, idempotency key or PayPal order ID ever leaves this file.

export type DashboardShop = { id: string; currency: string; timezone: string };

// A bound on what one refresh sends to a browser. Totals are computed without it.
const MAX_ROWS = 1000;
const MAX_DEMAND_EVENTS = 2000;
// How far ahead the bookings dataset reads, on top of the period behind today.
const BOOKINGS_AHEAD_DAYS = 31;

type DatasetOptions = { now?: Date; maxRows?: number };

// Whether an order can still be paid, read against the order's booking, which the query must join.
// Nothing is captured once a deposit's hold has ended, and a capture is only ever sent from
// `approved`, so a pending deposit with no live hold can never be paid. An approved one stays
// awaiting until reconciliation has read PayPal and closed it: a missing capture ID only means no
// answer was recorded, and the money may have moved.
function payableAt(now: Date) {
  return sql<boolean>`NOT COALESCE(
    ${orders.kind} = 'booking_deposit'
    AND ${orders.paypalCaptureId} IS NULL
    AND ${orders.paymentStatus} = 'pending'
    AND (${bookings.status} IS DISTINCT FROM 'held' OR ${bookings.holdExpiresAt} <= ${now.toISOString()}::timestamptz),
    false
  )`;
}

function shiftLocalDate({ year, month, day }: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function periodOf(shop: DashboardShop, rawQuery: unknown, now: Date) {
  const { days = DEFAULT_DASHBOARD_PERIOD } = parseInput(dashboardQuery, rawQuery);
  const periodDays = Number(days);
  const today = localDateOf(now, shop.timezone);
  const startDate = shiftLocalDate(today, 1 - periodDays);
  const from = localToInstant(startDate, 0, shop.timezone);
  return {
    today,
    from,
    envelope: {
      shopId: shop.id,
      currency: shop.currency,
      timezone: shop.timezone,
      generatedAt: now.toISOString(),
      periodDays,
      periodStartDate: formatLocalDate(startDate),
    },
  };
}

// The short form a seller can read out or compare. It identifies nothing outside this shop's view.
function referenceOf(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

function itemsSummary(lines: DashboardOrder["lines"]): string {
  return lines
    .map(({ title, quantity }) => (quantity > 1 ? `${quantity} x ${title}` : title))
    .join(", ");
}

export async function getDashboardOrders(
  db: Db,
  shop: DashboardShop,
  rawQuery: unknown,
  { now = new Date(), maxRows = MAX_ROWS }: DatasetOptions = {},
): Promise<DashboardOrders> {
  const { from, envelope } = periodOf(shop, rawQuery, now);
  const rows = await db
    .select({
      orderId: orders.id,
      kind: orders.kind,
      paymentStatus: orders.paymentStatus,
      approvalUrl: orders.approvalUrl,
      totalMinor: orders.totalMinor,
      currency: orders.currency,
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
      captureId: orders.paypalCaptureId,
      bookingId: bookings.id,
      payable: payableAt(now),
      bookingStatus: bookings.status,
      reviewReason: bookings.reviewReason,
      holdExpiresAt: bookings.holdExpiresAt,
      servicePriceMinor: bookings.servicePriceMinor,
      startsAt: bookings.startsAt,
    })
    .from(orders)
    .leftJoin(
      bookings,
      and(eq(bookings.orderId, orders.id), eq(bookings.shopId, orders.shopId)),
    )
    .where(and(eq(orders.shopId, shop.id), gte(orders.createdAt, from)))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(maxRows + 1);
  const visible = rows.slice(0, maxRows);

  const lines = visible.length
    ? await db
        .select({
          orderId: orderLines.orderId,
          productId: orderLines.productId,
          title: orderLines.title,
          quantity: orderLines.quantity,
          unitPriceMinor: orderLines.unitPriceMinor,
          lineTotalMinor: orderLines.lineTotalMinor,
        })
        .from(orderLines)
        .where(
          and(
            eq(orderLines.shopId, shop.id),
            inArray(
              orderLines.orderId,
              visible.map(({ orderId }) => orderId),
            ),
          ),
        )
        .orderBy(orderLines.createdAt, orderLines.id)
    : [];
  const linesByOrder = Map.groupBy(lines, ({ orderId }) => orderId);

  return {
    ...envelope,
    truncated: rows.length > maxRows,
    orders: visible.map((row) => {
      const orderLineRows = (linesByOrder.get(row.orderId) ?? []).map(
        ({ productId, title, quantity, unitPriceMinor, lineTotalMinor }) => ({
          productId,
          title,
          quantity,
          unitPriceMinor,
          lineTotalMinor,
        }),
      );
      const hasApprovalLink = row.approvalUrl !== null;
      return {
        orderId: row.orderId,
        reference: referenceOf(row.orderId),
        kind: row.kind,
        paymentStatus: row.paymentStatus,
        paymentGroup: paymentGroupOf(row.paymentStatus, hasApprovalLink, row.payable),
        hasApprovalLink,
        totalMinor: row.totalMinor,
        currency: row.currency,
        createdLocal: localDateTimeString(row.createdAt, shop.timezone),
        createdDate: formatLocalDate(localDateOf(row.createdAt, shop.timezone)),
        updatedLocal: localDateTimeString(row.updatedAt, shop.timezone),
        captureId: row.captureId,
        items: itemsSummary(orderLineRows),
        lines: orderLineRows,
        booking:
          row.bookingId && row.bookingStatus && row.servicePriceMinor !== null && row.startsAt && row.holdExpiresAt
            ? {
                bookingId: row.bookingId,
                // The same rule as the schedule: a hold ends at its exact instant.
                status:
                  row.bookingStatus === "held" && row.holdExpiresAt.getTime() <= now.getTime()
                    ? "expired"
                    : row.bookingStatus,
                reviewReason: row.reviewReason,
                servicePriceMinor: row.servicePriceMinor,
                remainingMinor: row.servicePriceMinor - row.totalMinor,
                startsLocal: localDateTimeString(row.startsAt, shop.timezone),
              }
            : null,
      };
    }),
  };
}

export async function getDashboardPayments(
  db: Db,
  shop: DashboardShop,
  rawQuery: unknown,
  { now = new Date(), maxRows = MAX_ROWS }: DatasetOptions = {},
): Promise<DashboardPayments> {
  const { from, envelope } = periodOf(shop, rawQuery, now);
  const inPeriod = and(eq(orders.shopId, shop.id), gte(orders.createdAt, from));

  // Per order first, because Postgres does not match an expression with parameters in GROUP BY.
  const perOrder = db
    .select({
      paymentStatus: orders.paymentStatus,
      hasLink: sql<boolean>`${orders.approvalUrl} IS NOT NULL`.as("has_link"),
      payable: payableAt(now).as("payable"),
      kind: orders.kind,
      currency: orders.currency,
      totalMinor: orders.totalMinor,
    })
    .from(orders)
    // One booking at most per order, so the join cannot count an order twice.
    .leftJoin(bookings, eq(bookings.orderId, orders.id))
    .where(inPeriod)
    .as("per_order");
  const [groups, paidRows] = await Promise.all([
    db
      .select({
        paymentStatus: perOrder.paymentStatus,
        hasLink: perOrder.hasLink,
        payable: perOrder.payable,
        kind: perOrder.kind,
        currency: perOrder.currency,
        // A bigint comes back as a string. Amounts are integers, so the sum stays exact.
        amountMinor: sql<string>`sum(${perOrder.totalMinor})`,
        orderCount: count(),
      })
      .from(perOrder)
      .groupBy(
        perOrder.paymentStatus,
        perOrder.hasLink,
        perOrder.payable,
        perOrder.kind,
        perOrder.currency,
      ),
    // Only reconciliation can mark an order paid, and the database refuses `paid` with no capture.
    db
      .select({
        captureId: orders.paypalCaptureId,
        orderId: orders.id,
        kind: orders.kind,
        amountMinor: orders.totalMinor,
        currency: orders.currency,
        createdAt: orders.createdAt,
        updatedAt: orders.updatedAt,
      })
      .from(orders)
      .where(and(inPeriod, eq(orders.paymentStatus, "paid")))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(maxRows + 1),
  ]);

  const totals = new Map<string, DashboardPaymentTotal>();
  for (const row of groups) {
    const group = paymentGroupOf(row.paymentStatus, row.hasLink, row.payable);
    const key = `${group}|${row.kind}|${row.currency}`;
    const total = totals.get(key) ?? {
      group,
      kind: row.kind,
      currency: row.currency,
      amountMinor: 0,
      orderCount: 0,
    };
    total.amountMinor += Number(row.amountMinor);
    total.orderCount += row.orderCount;
    totals.set(key, total);
  }

  const captures: DashboardCapture[] = paidRows.slice(0, maxRows).map((row) => ({
    captureId: row.captureId as string,
    orderId: row.orderId,
    reference: referenceOf(row.orderId),
    kind: row.kind,
    amountMinor: row.amountMinor,
    currency: row.currency,
    createdDate: formatLocalDate(localDateOf(row.createdAt, shop.timezone)),
    recordedLocal: localDateTimeString(row.updatedAt, shop.timezone),
  }));

  return {
    ...envelope,
    truncated: paidRows.length > maxRows,
    totals: [...totals.values()].sort((a, b) =>
      `${a.group}|${a.kind}|${a.currency}`.localeCompare(`${b.group}|${b.kind}|${b.currency}`),
    ),
    captures,
  };
}

export async function getDashboardBookings(
  db: Db,
  shop: DashboardShop,
  rawQuery: unknown,
  { now = new Date(), maxRows = MAX_ROWS }: DatasetOptions = {},
): Promise<DashboardBookings> {
  const { today, from, envelope } = periodOf(shop, rawQuery, now);
  const lastDate = shiftLocalDate(today, BOOKINGS_AHEAD_DAYS - 1);
  const to = localToInstant(shiftLocalDate(lastDate, 1), 0, shop.timezone);
  // The read model the schedule uses, so both pages agree on every state, expired holds included.
  const schedule = await getShopSchedule(db, shop.id, from, to, now);

  const rows: DashboardBooking[] = schedule.bookings.slice(0, maxRows).map((booking) => {
    const startsAt = new Date(booking.startsAt);
    return {
      bookingId: booking.bookingId,
      reference: referenceOf(booking.bookingId),
      status: booking.status,
      reviewReason: booking.reviewReason,
      paymentStatus: booking.paymentStatus,
      serviceTitle: booking.serviceTitle,
      technicianName: booking.technicianName,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      startsLocal: localDateTimeString(startsAt, shop.timezone),
      endsLocal: localDateTimeString(new Date(booking.endsAt), shop.timezone),
      startsDate: formatLocalDate(localDateOf(startsAt, shop.timezone)),
      holdExpiresAt: booking.holdExpiresAt,
      holdExpiresLocal: localDateTimeString(new Date(booking.holdExpiresAt), shop.timezone),
      priceMinor: booking.priceMinor,
      depositMinor: booking.depositMinor,
      remainingMinor: booking.remainingMinor,
      currency: booking.currency,
      captureId: booking.depositCaptureId,
    };
  });

  return {
    ...envelope,
    truncated: schedule.bookings.length > maxRows,
    rangeEndDate: formatLocalDate(lastDate),
    bookings: rows,
  };
}

export async function getDashboardDemand(
  db: Db,
  shop: DashboardShop,
  rawQuery: unknown,
  { now = new Date(), maxRows = MAX_DEMAND_EVENTS }: DatasetOptions = {},
): Promise<DashboardDemand> {
  const { from, envelope } = periodOf(shop, rawQuery, now);
  // A seller's view reads attributed rows only. A global miss belongs to nobody, and a row
  // attributed to another shop is that shop's.
  const attributedHere = and(
    eq(searchEvents.attributedShopId, shop.id),
    gte(searchEvents.createdAt, from),
  );
  const [events, [unmet], [served]] = await Promise.all([
    db
      .select({
        query: searchEvents.queryNormalized,
        words: searchEvents.attributionWords,
        productIds: searchEvents.attributionProductIds,
        degraded: searchEvents.degraded,
        origin: searchEvents.origin,
        location: searchEvents.location,
        maxPriceMinor: searchEvents.maxPriceMinor,
        currency: searchEvents.currency,
        kind: searchEvents.kind,
        createdAt: searchEvents.createdAt,
      })
      .from(searchEvents)
      .where(attributedHere)
      .orderBy(desc(searchEvents.createdAt), desc(searchEvents.id))
      .limit(maxRows + 1),
    db.select({ searches: count() }).from(searchEvents).where(attributedHere),
    db
      .select({ searches: sql<number>`count(DISTINCT ${searchEvents.searchId})::int` })
      .from(searchEvents)
      .where(
        and(
          gte(searchEvents.createdAt, from),
          sql`${searchEvents.matchedProductIds} && ARRAY(SELECT ${products.id} FROM ${products} WHERE ${products.shopId} = ${shop.id})`,
        ),
      ),
  ]);
  const visible = events.slice(0, maxRows);

  // Only this shop's listings are named, whatever an event's array holds.
  const productIds = [...new Set(visible.flatMap((event) => event.productIds))];
  const listings = productIds.length
    ? await db
        .select({ id: products.id, title: products.title })
        .from(products)
        .where(and(eq(products.shopId, shop.id), inArray(products.id, productIds)))
    : [];
  const titles = new Map(listings.map(({ id, title }) => [id, title]));

  // Events arrive newest first, so the first of a query sets its last time and its filters.
  const rows = new Map<string, DashboardDemandRow & { listingIds: Set<string> }>();
  for (const event of visible) {
    const row = rows.get(event.query) ?? {
      query: event.query,
      searches: 0,
      sampleSearches: 0,
      degradedSearches: 0,
      lastSearchedLocal: localDateTimeString(event.createdAt, shop.timezone),
      sharedWords: [],
      listings: [],
      listingIds: new Set<string>(),
      location: event.location,
      maxPriceMinor: event.maxPriceMinor,
      currency: event.currency,
      kind: event.kind,
    };
    row.searches += 1;
    row.sampleSearches += event.origin === "fixture" ? 1 : 0;
    row.degradedSearches += event.degraded ? 1 : 0;
    row.sharedWords = [...new Set([...row.sharedWords, ...event.words])];
    event.productIds.forEach((id) => row.listingIds.add(id));
    rows.set(event.query, row);
  }

  return {
    ...envelope,
    truncated: events.length > maxRows,
    unmetSearches: unmet.searches,
    servedSearches: served.searches,
    demand: [...rows.values()]
      .map(({ listingIds, ...row }) => ({
        ...row,
        listings: [...listingIds].flatMap((id) => titles.get(id) ?? []),
      }))
      .sort(
        (a, b) =>
          b.searches - a.searches ||
          b.lastSearchedLocal.localeCompare(a.lastSearchedLocal) ||
          a.query.localeCompare(b.query),
      ),
  };
}
