import type {
  DashboardOrder,
  DashboardPaymentTotal,
  PaymentGroup,
} from "@/server/contracts/seller-dashboard";
import type { DemandGroup } from "@/server/contracts/seller-insights";
import { minorToDecimal } from "@/server/domain/money";

// The words for an order's money, shared by the widgets, the grid and the order details, so they
// can never disagree. Every state has words, because color alone must never carry it.

export const PAYMENT_GROUP_LABELS: Record<PaymentGroup, string> = {
  paid: "Paid",
  awaiting: "Awaiting payment",
  review: "Needs review",
  closed: "Closed, no money",
};

export const ORDER_KIND_LABELS: Record<DashboardOrder["kind"], string> = {
  purchase: "Purchase",
  booking_deposit: "Booking deposit",
};

export function orderStatusLabel(
  order: Pick<DashboardOrder, "paymentStatus" | "hasApprovalLink" | "paymentGroup">,
): string {
  switch (order.paymentStatus) {
    case "paid":
      return "Paid";
    case "approved":
      return order.paymentGroup === "closed" ? "Hold ended, not charged" : "Approved, capture not finished";
    case "pending":
      if (!order.hasApprovalLink) {
        return "No payment link";
      }
      return order.paymentGroup === "closed" ? "Hold ended, not charged" : "Waiting for the buyer";
    case "review_required":
      return "Needs review";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
  }
}

export function money(minor: number, currency: string): string {
  try {
    return `${minorToDecimal(minor, currency)} ${currency}`;
  } catch {
    // A currency this build cannot divide is still shown, and never as a wrong amount.
    return `${minor} minor units of ${currency}`;
  }
}

// What the order's money means and what to do, for its details.
export function orderMoneyText(
  order: Pick<DashboardOrder, "paymentGroup" | "paymentStatus" | "hasApprovalLink" | "totalMinor" | "currency" | "booking">,
): string {
  const amount = money(order.totalMinor, order.currency);
  switch (order.paymentGroup) {
    case "paid":
      if (!order.booking) {
        return `${amount} captured and on its way to your PayPal account.`;
      }
      // A deposit that arrived when its time was no longer held is not a booking with a balance.
      if (order.booking.status !== "confirmed") {
        return order.booking.reviewReason === "captured_after_cancel"
          ? `${amount} deposit captured after the order was cancelled. This time is not reserved for the buyer, so refund or rebook them.`
          : `${amount} deposit captured after the hold ended. This time is not reserved for the buyer, so refund or rebook them.`;
      }
      return `${amount} deposit captured. ${money(order.booking.remainingMinor, order.currency)} of the ${money(order.booking.servicePriceMinor, order.currency)} service price is paid at the shop.`;
    case "awaiting":
      return order.paymentStatus === "approved"
        ? `The buyer approved ${amount} in PayPal and the capture has not finished. This is not revenue yet.`
        : `${amount} is waiting for the buyer to approve it in PayPal. This is not revenue yet.`;
    case "review":
      return `Something about this ${amount} order does not match PayPal. Check it in your PayPal account before you act on it.`;
    case "closed":
      if (order.paymentStatus === "pending" && !order.hasApprovalLink) {
        return `PayPal has not issued a link for this ${amount} order, so nobody can pay it.`;
      }
      if (order.booking && (order.paymentStatus === "pending" || order.paymentStatus === "approved")) {
        return `The hold on this time ended before the deposit was captured, so this ${amount} will not be charged.`;
      }
      return `No money was taken for this ${amount} order.`;
  }
}

// What is left to pay at the shop, only while the booking still holds its time. A deposit that
// arrived late, or a booking that ended, has no appointment for a balance to be due on.
export function dueAtShopText(
  booking: Pick<NonNullable<DashboardOrder["booking"]>, "status" | "remainingMinor">,
  currency: string,
): string {
  return booking.status === "held" || booking.status === "confirmed"
    ? money(booking.remainingMinor, currency)
    : "Nothing, this time is not reserved";
}

export type GroupTotal = {
  group: PaymentGroup;
  currency: string;
  amountMinor: number;
  orderCount: number;
  purchasesMinor: number;
  depositsMinor: number;
};

// One entry per group and currency. Amounts in different currencies are never added together.
export function groupTotals(totals: DashboardPaymentTotal[]): GroupTotal[] {
  const merged = new Map<string, GroupTotal>();
  for (const total of totals) {
    const key = `${total.group}|${total.currency}`;
    const entry = merged.get(key) ?? {
      group: total.group,
      currency: total.currency,
      amountMinor: 0,
      orderCount: 0,
      purchasesMinor: 0,
      depositsMinor: 0,
    };
    entry.amountMinor += total.amountMinor;
    entry.orderCount += total.orderCount;
    if (total.kind === "booking_deposit") {
      entry.depositsMinor += total.amountMinor;
    } else {
      entry.purchasesMinor += total.amountMinor;
    }
    merged.set(key, entry);
  }
  return [...merged.values()];
}

export function count(amount: number, noun: string): string {
  return `${amount} ${noun}${amount === 1 ? "" : "s"}`;
}

export function searches(amount: number): string {
  return amount === 1 ? "1 search" : `${amount} searches`;
}

export function shopDateTime(local: string): string {
  const date = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${local.slice(0, 10)}T00:00:00Z`));
  return `${date}, ${local.slice(11, 16)}`;
}

// The attribution basis in words, which the demand widget shows for every row.
export function attributionBasis(sharedWords: string, listings: string): string {
  const words = sharedWords || "none recorded";
  return listings ? `Your listings share: ${words}. Closest: ${listings}.` : `Your listings share: ${words}.`;
}

// A window as a seller reads it. The dates are shop calendar days, written as they are stored.
export function windowText(startDate: string, endDate: string): string {
  return `${shopDay(startDate)} to ${shopDay(endDate)}`;
}

function shopDay(date: string): string {
  const [year, month, day] = date.slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

// What was recorded, in plain counts and nothing else, so it can stand with no model at all.
export function demandObservation(group: DemandGroup): string {
  const asked = group.examples.map(({ query, searches: times }) => `"${query}" (${times})`).join(", ");
  const more = group.examplesOmitted > 0 ? ` and ${count(group.examplesOmitted, "more wording")}` : "";
  const source =
    group.sampleSearches === 0
      ? "All recorded."
      : group.recordedSearches === 0
        ? "All are demo samples, not real buyers."
        : `${group.recordedSearches} recorded and ${count(group.sampleSearches, "demo sample")}.`;
  return `${searches(group.searches)} found nothing: ${asked}${more}. ${source}`;
}
