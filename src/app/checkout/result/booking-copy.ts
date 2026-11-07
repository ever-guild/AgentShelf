import type { BuyerOrder } from "@/server/services/storefront";

// One line of the slip under the message. The state of the money is always in the words, and its
// color only repeats them.
export type SlipRow = {
  label: string;
  value: string;
  standing?: "accepted" | "doubt";
};

// What a deposit order means depends on its booking, and a paid deposit on its own says nothing about
// whether the appointment stands.
export function bookingCopy(
  booking: NonNullable<BuyerOrder["booking"]>,
  paymentStatus: BuyerOrder["paymentStatus"],
  amount: string,
  remaining: string,
  shop: string,
): { title: string; body: string; rows: SlipRow[] } | undefined {
  // The payment's own words come first while its outcome is open or needs a person. A refund, for
  // one, sends the order to review and leaves the booking as it was.
  if (paymentStatus === "approved" || paymentStatus === "review_required") {
    return undefined;
  }
  const when = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: booking.timezone,
  }).format(new Date(booking.startsAt));
  const notCharged: SlipRow[] = [{ label: "Deposit, not charged", value: amount }];

  switch (booking.status) {
    case "confirmed":
      return {
        title: "Your booking is confirmed",
        body: `PayPal has confirmed your deposit of ${amount}. ${shop} expects you on ${when}, shop time. ${remaining} is left to pay at the shop.`,
        rows: [
          { label: "Appointment, shop time", value: when },
          { label: "Deposit paid", value: amount, standing: "accepted" },
          { label: "Left to pay at the shop", value: remaining },
        ],
      };
    case "review_required":
      return {
        title: "Your deposit arrived after the hold ended",
        body: `PayPal has taken your deposit of ${amount}, but this time was no longer being held for you, so the appointment is not confirmed. ${shop} will refund the deposit or offer another time. Please do not pay again.`,
        rows: [
          { label: "Appointment, not confirmed", value: when, standing: "doubt" },
          { label: "Deposit taken by PayPal", value: amount },
        ],
      };
    case "expired":
      return {
        title: "This hold has ended",
        body: "The time was only held for a short while, and it has been released. You have not been charged, even if you approved the payment in PayPal. Your assistant can find another time.",
        rows: notCharged,
      };
    case "cancelled":
      return {
        title: "Booking not completed",
        body: "This time has been released. You have not been charged, even if you approved the payment in PayPal. Your assistant can find another time.",
        rows: notCharged,
      };
    case "held":
      return undefined;
  }
}
