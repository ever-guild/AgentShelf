import type {
  DashboardOrder,
  DashboardPaymentTotal,
  PaymentGroup,
} from "@/server/contracts/seller-dashboard";
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

export function orderStatusLabel(order: Pick<DashboardOrder, "paymentStatus" | "hasApprovalLink">): string {
  switch (order.paymentStatus) {
    case "paid":
      return "Paid";
    case "approved":
      return "Approved, capture not finished";
    case "pending":
      return order.hasApprovalLink ? "Waiting for the buyer" : "No payment link";
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
      return order.booking
        ? `${amount} deposit captured. ${money(order.booking.remainingMinor, order.currency)} of the ${money(order.booking.servicePriceMinor, order.currency)} service price is paid at the shop.`
        : `${amount} captured and on its way to your PayPal account.`;
    case "awaiting":
      return order.paymentStatus === "approved"
        ? `The buyer approved ${amount} in PayPal and the capture has not finished. This is not revenue yet.`
        : `${amount} is waiting for the buyer to approve it in PayPal. This is not revenue yet.`;
    case "review":
      return `Something about this ${amount} order does not match PayPal. Check it in your PayPal account before you act on it.`;
    case "closed":
      return order.paymentStatus === "pending"
        ? `PayPal has not issued a link for this ${amount} order, so nobody can pay it.`
        : `No money was taken for this ${amount} order.`;
  }
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
