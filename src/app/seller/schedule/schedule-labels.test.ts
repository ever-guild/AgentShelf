import { describe, expect, it } from "vitest";

import { depositText, effectiveStatus, longDate, shiftDate, statusLabel } from "./schedule-labels";

const booking = {
  paymentStatus: "pending",
  reviewReason: null,
  depositMinor: 2000,
  remainingMinor: 6000,
  currency: "EUR",
  holdExpiresLocal: "2026-11-09T09:15:00",
} as const;

describe("effectiveStatus", () => {
  const holdExpiresAt = "2026-11-09T07:15:00.000Z";
  const end = Date.parse(holdExpiresAt);

  it("ends a hold at its exact instant, even with no refresh", () => {
    expect(effectiveStatus({ status: "held", holdExpiresAt }, end - 1)).toBe("held");
    expect(effectiveStatus({ status: "held", holdExpiresAt }, end)).toBe("expired");
  });

  it("leaves every other state as the server said", () => {
    for (const status of ["confirmed", "review_required", "cancelled", "expired"] as const) {
      expect(effectiveStatus({ status, holdExpiresAt }, end + 1)).toBe(status);
    }
  });
});

describe("statusLabel", () => {
  it("gives every state its own words", () => {
    const labels = (["held", "confirmed", "expired", "cancelled", "review_required"] as const).map(
      (status) => statusLabel(status, "paid"),
    );
    expect(new Set(labels).size).toBe(5);
  });

  it("does not call an unpaid confirmed booking simply confirmed", () => {
    expect(statusLabel("confirmed", "paid")).toBe("Confirmed");
    expect(statusLabel("confirmed", "review_required")).toBe("Confirmed, check payment");
  });

  it("asks for a check when released time has a capture open or landed", () => {
    for (const paymentStatus of ["approved", "paid", "review_required"] as const) {
      expect(statusLabel("expired", paymentStatus)).toBe("Expired, check payment");
      expect(statusLabel("cancelled", paymentStatus)).toBe("Cancelled, check payment");
    }
    expect(statusLabel("expired", "cancelled")).toBe("Expired");
    expect(statusLabel("cancelled", "failed")).toBe("Cancelled");
  });
});

describe("depositText", () => {
  it("says a hold is unpaid, and when it ends in shop time", () => {
    expect(depositText(booking, "held")).toBe(
      "Deposit of 20.00 EUR not paid yet. The hold ends at 09:15.",
    );
  });

  it("only says paid when the payment is paid", () => {
    expect(depositText({ ...booking, paymentStatus: "paid" }, "confirmed")).toBe(
      "Deposit of 20.00 EUR paid. 60.00 EUR is due at the shop.",
    );
    expect(depositText({ ...booking, paymentStatus: "review_required" }, "confirmed")).toContain(
      "Check the deposit",
    );
  });

  it("never says an expired or cancelled booking was paid", () => {
    expect(depositText(booking, "expired")).toContain("No deposit was paid");
    expect(depositText(booking, "cancelled")).toContain("free again");
  });

  it("never says no deposit was paid while a capture is open or has landed", () => {
    for (const status of ["expired", "cancelled"] as const) {
      for (const paymentStatus of ["approved", "paid", "review_required"] as const) {
        const text = depositText({ ...booking, paymentStatus }, status);
        expect(text).not.toContain("No deposit was paid");
        expect(text).not.toContain("The order was cancelled");
        expect(text).toContain("refund or rebook");
      }
    }
    expect(depositText({ ...booking, paymentStatus: "approved" }, "expired")).toContain(
      "still finishing the deposit of 20.00 EUR",
    );
  });

  it("tells the seller what to do with a late deposit", () => {
    expect(
      depositText({ ...booking, paymentStatus: "paid", reviewReason: "late_capture" }, "review_required"),
    ).toContain("after the hold ended");
    expect(
      depositText(
        { ...booking, paymentStatus: "paid", reviewReason: "captured_after_cancel" },
        "review_required",
      ),
    ).toContain("after the order was cancelled");
  });
});

describe("dates", () => {
  it("moves by whole days across a clock change and a month end", () => {
    expect(shiftDate("2027-03-27", 1)).toBe("2027-03-28");
    expect(shiftDate("2027-03-28", 1)).toBe("2027-03-29");
    expect(shiftDate("2027-10-31", 1)).toBe("2027-11-01");
    expect(shiftDate("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("names the day it is given in any browser zone", () => {
    expect(longDate("2026-11-09")).toBe("Monday, 9 November 2026");
  });
});
