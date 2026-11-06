import { describe, expect, it } from "vitest";

import { paymentGroupOf } from "@/server/contracts/seller-dashboard";

import {
  attributionBasis,
  groupTotals,
  money,
  orderMoneyText,
  orderStatusLabel,
  searches,
  shopDateTime,
} from "./dashboard-labels";

describe("payment groups", () => {
  it.each([
    ["paid", true, "paid"],
    ["approved", true, "awaiting"],
    ["approved", false, "awaiting"],
    ["pending", true, "awaiting"],
    ["pending", false, "closed"],
    ["review_required", true, "review"],
    ["cancelled", true, "closed"],
    ["failed", true, "closed"],
  ] as const)("%s with a link %s is %s", (status, hasLink, group) => {
    expect(paymentGroupOf(status, hasLink)).toBe(group);
  });
});

describe("group totals", () => {
  it("adds purchases and deposits within a currency, and never across currencies", () => {
    const totals = groupTotals([
      { group: "paid", kind: "purchase", currency: "EUR", amountMinor: 2730, orderCount: 2 },
      { group: "paid", kind: "booking_deposit", currency: "EUR", amountMinor: 2000, orderCount: 1 },
      { group: "paid", kind: "purchase", currency: "USD", amountMinor: 100, orderCount: 1 },
      { group: "awaiting", kind: "purchase", currency: "EUR", amountMinor: 750, orderCount: 1 },
    ]);

    expect(totals).toContainEqual({
      group: "paid",
      currency: "EUR",
      amountMinor: 4730,
      orderCount: 3,
      purchasesMinor: 2730,
      depositsMinor: 2000,
    });
    expect(totals.find(({ currency }) => currency === "USD")?.amountMinor).toBe(100);
    expect(totals.find(({ group }) => group === "awaiting")?.amountMinor).toBe(750);
  });
});

describe("words for money", () => {
  const order = {
    paymentGroup: "paid",
    paymentStatus: "paid",
    hasApprovalLink: true,
    totalMinor: 2000,
    currency: "EUR",
    booking: null,
  } as const;

  it("shows the currency with every amount", () => {
    expect(money(1250, "EUR")).toBe("12.50 EUR");
    expect(money(5, "EUR")).toBe("0.05 EUR");
  });

  it("says a deposit is part of the price, and what is left to pay at the shop", () => {
    const text = orderMoneyText({
      ...order,
      booking: {
        bookingId: "b",
        status: "confirmed",
        servicePriceMinor: 8000,
        remainingMinor: 6000,
        startsLocal: "2026-11-09T12:00:00",
      },
    });
    expect(text).toBe("20.00 EUR deposit captured. 60.00 EUR of the 80.00 EUR service price is paid at the shop.");
  });

  it("never calls waiting money revenue", () => {
    expect(orderMoneyText({ ...order, paymentGroup: "awaiting", paymentStatus: "pending" })).toContain(
      "not revenue yet",
    );
    expect(orderMoneyText({ ...order, paymentGroup: "awaiting", paymentStatus: "approved" })).toContain(
      "not revenue yet",
    );
  });

  it("names each payment state", () => {
    expect(orderStatusLabel({ paymentStatus: "pending", hasApprovalLink: false })).toBe("No payment link");
    expect(orderStatusLabel({ paymentStatus: "pending", hasApprovalLink: true })).toBe("Waiting for the buyer");
    expect(orderStatusLabel({ paymentStatus: "approved", hasApprovalLink: true })).toBe(
      "Approved, capture not finished",
    );
  });
});

describe("other words", () => {
  it("states the attribution basis", () => {
    expect(attributionBasis("charger", "USB-C wall charger")).toBe(
      "Your listings share: charger. Closest: USB-C wall charger.",
    );
    expect(attributionBasis("", "")).toBe("Your listings share: none recorded.");
  });

  it("reads wall clock as written, in any browser's timezone", () => {
    expect(shopDateTime("2026-11-09T12:00:00")).toBe("Mon 9 Nov, 12:00");
  });

  it("counts searches", () => {
    expect(searches(1)).toBe("1 search");
    expect(searches(2)).toBe("2 searches");
  });
});
