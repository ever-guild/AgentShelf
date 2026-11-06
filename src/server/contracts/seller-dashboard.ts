import { z } from "zod";

import type { ScheduleBooking, ScheduleStatus } from "./seller-schedule";

// What a seller may ask of their dashboard: how far back to look, in days of shop time. Strict, so
// a request naming a shop is refused rather than ignored. The shop always comes from the session.

export const DASHBOARD_PERIODS = ["7", "30", "60"] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];
export const DEFAULT_DASHBOARD_PERIOD: DashboardPeriod = "30";

export const dashboardQuery = z.strictObject({
  days: z.enum(DASHBOARD_PERIODS).optional(),
});

type PaymentStatus = ScheduleBooking["paymentStatus"];
type OrderKind = "purchase" | "booking_deposit";

// Where an order's money stands for a seller. Only `paid` is revenue, and awaiting payment is kept
// apart from it, because a buyer who has a link may never use it.
export type PaymentGroup = "paid" | "awaiting" | "review" | "closed";

// The one definition, for rows and totals alike. A pending order with no link is not waiting for
// anyone: PayPal has not issued one, so nobody can pay it.
export function paymentGroupOf(paymentStatus: PaymentStatus, hasApprovalLink: boolean): PaymentGroup {
  switch (paymentStatus) {
    case "paid":
      return "paid";
    case "approved":
      return "awaiting";
    case "pending":
      return hasApprovalLink ? "awaiting" : "closed";
    case "review_required":
      return "review";
    case "cancelled":
    case "failed":
      return "closed";
  }
}

// Every answer says whose it is and when it was read. An open page compares `shopId`, because a
// sign-in to another shop in the same browser changes whose data its next refresh brings back.
type DashboardEnvelope = {
  shopId: string;
  currency: string;
  timezone: string;
  generatedAt: string;
  periodDays: number;
  // The first day counted, in shop time.
  periodStartDate: string;
  // More rows exist than were sent. Totals are computed before this limit, so they stay whole.
  truncated: boolean;
};

export type DashboardOrder = {
  orderId: string;
  reference: string;
  kind: OrderKind;
  paymentStatus: PaymentStatus;
  paymentGroup: PaymentGroup;
  hasApprovalLink: boolean;
  totalMinor: number;
  currency: string;
  // Shop wall clock with no offset, and the shop's calendar day.
  createdLocal: string;
  createdDate: string;
  updatedLocal: string;
  // The seller's own PayPal capture, to find this payment in their PayPal account.
  captureId: string | null;
  items: string;
  lines: {
    productId: string;
    title: string;
    quantity: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
  }[];
  // Set on a deposit: what the whole service costs, so the deposit can be read against it.
  booking: {
    bookingId: string;
    status: ScheduleStatus;
    servicePriceMinor: number;
    remainingMinor: number;
    startsLocal: string;
  } | null;
};

export type DashboardOrders = DashboardEnvelope & { orders: DashboardOrder[] };

export type DashboardPaymentTotal = {
  group: PaymentGroup;
  kind: OrderKind;
  currency: string;
  amountMinor: number;
  orderCount: number;
};

export type DashboardCapture = {
  captureId: string;
  orderId: string;
  reference: string;
  kind: OrderKind;
  amountMinor: number;
  currency: string;
  createdDate: string;
  // When the order last changed, which for a paid order is when the capture was recorded.
  recordedLocal: string;
};

export type DashboardPayments = DashboardEnvelope & {
  // From every order in the period, summed by the database.
  totals: DashboardPaymentTotal[];
  captures: DashboardCapture[];
};

export type DashboardBooking = {
  bookingId: string;
  reference: string;
  status: ScheduleStatus;
  reviewReason: ScheduleBooking["reviewReason"];
  paymentStatus: PaymentStatus;
  serviceTitle: string;
  technicianName: string;
  startsAt: string;
  endsAt: string;
  startsLocal: string;
  endsLocal: string;
  startsDate: string;
  holdExpiresAt: string;
  holdExpiresLocal: string;
  priceMinor: number;
  depositMinor: number;
  remainingMinor: number;
  currency: string;
  captureId: string | null;
};

export type DashboardBookings = DashboardEnvelope & {
  // The last day counted. Bookings are read from the period's start to this day.
  rangeEndDate: string;
  bookings: DashboardBooking[];
};

export type DashboardDemandRow = {
  query: string;
  searches: number;
  // Of `searches`, how many are labeled demo samples rather than recorded activity.
  sampleSearches: number;
  // Of `searches`, how many ran while some listings had no search terms, so they may be a wording
  // gap rather than a gap in stock.
  degradedSearches: number;
  lastSearchedLocal: string;
  // The attribution basis: the query's words this shop's listings share, and those listings.
  sharedWords: string[];
  listings: string[];
  // What the most recent of these searches also asked for.
  location: string | null;
  maxPriceMinor: number | null;
  currency: string | null;
  kind: "product" | "service" | null;
};

export type DashboardDemand = DashboardEnvelope & {
  // Searches in the period that found nothing and are attributed to this shop.
  unmetSearches: number;
  // Searches in the period that returned at least one of this shop's listings.
  servedSearches: number;
  demand: DashboardDemandRow[];
};
