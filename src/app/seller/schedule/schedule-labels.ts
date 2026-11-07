import type { ScheduleBooking, ScheduleStatus } from "@/server/contracts/seller-schedule";
import { minorToDecimal } from "@/server/domain/money";

// The words for a booking's state, shared by the timeline and the list so they can never disagree.
// Every state has words, because color alone must never carry it.

// A hold ends at its exact instant even if the next refresh has not arrived, or never does.
// `nowMs` is the server's clock as the page estimates it.
export function effectiveStatus(
  booking: Pick<ScheduleBooking, "status" | "holdExpiresAt">,
  nowMs: number,
): ScheduleStatus {
  return booking.status === "held" && Date.parse(booking.holdExpiresAt) <= nowMs
    ? "expired"
    : booking.status;
}

const STATUS_LABELS: Record<ScheduleStatus, string> = {
  held: "Held",
  confirmed: "Confirmed",
  expired: "Expired",
  cancelled: "Cancelled",
  review_required: "Needs review",
};

// A capture that is still open at PayPal, has landed, or needs a person. A booking that no longer
// holds its time must not read as if no money moved while one of these is true.
function captureOpenOrLanded(paymentStatus: ScheduleBooking["paymentStatus"]): boolean {
  return paymentStatus === "approved" || paymentStatus === "paid" || paymentStatus === "review_required";
}

// A confirmed booking whose payment went back to review, or a released time whose deposit capture
// is open or has landed. The schedule and the dashboard mark these in the color of doubt.
export function paymentToCheck(
  status: ScheduleStatus,
  paymentStatus: ScheduleBooking["paymentStatus"],
): boolean {
  if (status === "confirmed") {
    return paymentStatus !== "paid";
  }
  return (status === "expired" || status === "cancelled") && captureOpenOrLanded(paymentStatus);
}

// A booking whose payment needs a check shows both, as the read model asks.
export function statusLabel(
  status: ScheduleStatus,
  paymentStatus: ScheduleBooking["paymentStatus"],
): string {
  return paymentToCheck(status, paymentStatus)
    ? `${STATUS_LABELS[status]}, check payment`
    : STATUS_LABELS[status];
}

function money(minor: number, currency: string): string {
  return `${minorToDecimal(minor, currency)} ${currency}`;
}

export function shopTime(localDateTime: string): string {
  return localDateTime.slice(11, 16);
}

// What the seller should know about the deposit in this state, and what to do if anything.
export function depositText(
  booking: Pick<
    ScheduleBooking,
    | "paymentStatus"
    | "reviewReason"
    | "depositMinor"
    | "remainingMinor"
    | "currency"
    | "holdExpiresLocal"
  >,
  status: ScheduleStatus,
): string {
  const deposit = money(booking.depositMinor, booking.currency);
  switch (status) {
    case "held":
      return `Deposit of ${deposit} not paid yet. The hold ends at ${shopTime(booking.holdExpiresLocal)}.`;
    case "confirmed":
      return booking.paymentStatus === "paid"
        ? `Deposit of ${deposit} paid. ${money(booking.remainingMinor, booking.currency)} is due at the shop.`
        : `Check the deposit of ${deposit} in PayPal before this appointment. It is no longer marked as paid.`;
    case "expired":
    case "cancelled":
      if (booking.paymentStatus === "approved") {
        return `PayPal was still finishing the deposit of ${deposit} when this time was released. It is free again, so if the money arrives, refund or rebook the buyer.`;
      }
      if (captureOpenOrLanded(booking.paymentStatus)) {
        return `Check the deposit of ${deposit} in PayPal. This time is free again, so refund or rebook the buyer if the money arrived.`;
      }
      return status === "expired"
        ? "No deposit was paid in time, so this time is free again."
        : "The order was cancelled, so this time is free again.";
    case "review_required":
      return booking.reviewReason === "captured_after_cancel"
        ? `Deposit of ${deposit} arrived after the order was cancelled. This time is not reserved, so refund or rebook the buyer.`
        : `Deposit of ${deposit} arrived after the hold ended. This time is not reserved, so refund or rebook the buyer.`;
  }
}

// A day before or after, on the date alone, so a clock change cannot move it.
export function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function longDate(date: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

export function shortDate(date: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}
