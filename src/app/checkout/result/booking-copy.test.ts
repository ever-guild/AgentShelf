import { describe, expect, it } from "vitest";

import { bookingCopy } from "./booking-copy";

const booking = (status: "confirmed" | "review_required" | "held" | "expired" | "cancelled") => ({
  bookingId: "11111111-1111-4111-8111-111111111111",
  status,
  reviewReason: null,
  startsAt: "2026-11-09T10:00:00.000Z",
  endsAt: "2026-11-09T11:00:00.000Z",
  expiresAt: "2026-11-06T10:15:00.000Z",
  timezone: "Europe/Riga",
  depositMinor: 2000,
  remainingMinor: 6000,
});

const copy = (
  status: Parameters<typeof booking>[0],
  paymentStatus: Parameters<typeof bookingCopy>[1],
) => bookingCopy(booking(status), paymentStatus, "20.00 EUR", "60.00 EUR", "Fixit");

describe("what a deposit's result page says", () => {
  it("confirms a booking whose deposit is paid", () => {
    expect(copy("confirmed", "paid")?.title).toBe("Your booking is confirmed");
  });

  it("explains a deposit that arrived after the hold ended", () => {
    expect(copy("review_required", "paid")?.title).toBe("Your deposit arrived after the hold ended");
  });

  // A refund leaves the booking confirmed and sends the order to review.
  it.each(["confirmed", "review_required", "expired", "cancelled"] as const)(
    "does not speak for the payment when a %s booking's order needs a person",
    (status) => {
      expect(copy(status, "review_required")).toBeUndefined();
    },
  );

  it("does not speak for a payment whose outcome is open", () => {
    expect(copy("confirmed", "approved")).toBeUndefined();
    expect(copy("expired", "approved")).toBeUndefined();
  });

  it("says a hold ended when no money moved", () => {
    expect(copy("expired", "cancelled")?.title).toBe("This hold has ended");
    expect(copy("cancelled", "failed")?.title).toBe("Booking not completed");
  });
});
