import { describe, expect, it } from "vitest";

import { currencyFromToken, parsePriceText } from "./price-text";

describe("reading a price as a person wrote it", () => {
  it.each([
    ["12", 1200, null],
    ["12.5", 1250, null],
    ["12,5", 1250, null],
    ["12.50", 1250, null],
    ["12,50", 1250, null],
    ["0.99", 99, null],
    ["1.20", 120, null],
    ["12,-", 1200, null],
    ["12.-", 1200, null],
    ["12,--", 1200, null],
    ["12,50 €", 1250, "EUR"],
    ["€12.50", 1250, "EUR"],
    ["€ 12.50", 1250, "EUR"],
    ["12.50€", 1250, "EUR"],
    ["12.50 EUR", 1250, "EUR"],
    ["eur 12.50", 1250, "EUR"],
    ["12.50 eiro", 1250, "EUR"],
    ["89 euro", 8900, "EUR"],
    ["12,- €", 1200, "EUR"],
    ["$12.50", 1250, "USD"],
    ["12.50 USD", 1250, "USD"],
    ["£9", 900, "GBP"],
    ["25 zł", 2500, "PLN"],
    ["1 200", 120000, null],
    ["1'200", 120000, null],
    ["1 200,50", 120050, null],
    ["1.200,50", 120050, null],
    ["1,200.50", 120050, null],
    ["1.200.000", 120000000, null],
    ["1,200,000", 120000000, null],
    ["1 200 €", 120000, "EUR"],
    // A non-breaking space between the groups, as spreadsheets write it.
    ["1 200,50 €", 120050, "EUR"],
    ["  12.50  ", 1250, null],
  ])("reads %j", (text, minor, currency) => {
    expect(parsePriceText(text)).toEqual({ minor, currency, problem: null });
  });

  it.each(["", "   ", "-", "--", "—", "?", "n/a", "N/A", "tbd", null, undefined])(
    "treats %j as no price",
    (text) => {
      expect(parsePriceText(text)).toEqual({
        minor: null,
        currency: null,
        problem: "missing",
      });
    },
  );

  // Each of these has a tempting reading. Taking it could charge a buyer the wrong amount.
  it.each([
    ["1.200", "ambiguous"],
    ["1,200", "ambiguous"],
    ["12.505", "ambiguous"],
    ["1.200 €", "ambiguous"],
    ["from 20", "unreadable"],
    ["no 20 €", "unreadable"],
    ["~20", "unreadable"],
    ["20+", "unreadable"],
    ["20-30", "unreadable"],
    ["20–30 €", "unreadable"],
    ["-5", "unreadable"],
    ["12.5.5", "unreadable"],
    ["1,200,50", "unreadable"],
    ["12 34", "unreadable"],
    ["1.20.300", "unreadable"],
    ["1 200.000", "unreadable"],
    ["12.50,5", "unreadable"],
    ["free", "unreadable"],
    ["call us", "unreadable"],
    ["5 €/gab.", "unreadable"],
    ["12.5-", "unreadable"],
    ["12,50,-", "unreadable"],
    ["1.200,-,", "unreadable"],
    ["1e3", "unreadable"],
    ["0x10", "unreadable"],
    ["١٢", "unreadable"],
    ["12 ₽", "unreadable"],
    ["0", "not_positive"],
    ["0.00", "not_positive"],
    ["0 €", "not_positive"],
    ["99999999999", "too_large"],
    ["21474836.48", "too_large"],
    ["999999999999999999999999", "too_large"],
  ])("does not turn %j into a price", (text, problem) => {
    const parsed = parsePriceText(text);
    expect(parsed.minor).toBeNull();
    expect(parsed.problem).toBe(problem);
  });

  it("accepts the largest amount the database can store", () => {
    expect(parsePriceText("21474836.47")).toEqual({
      minor: 2147483647,
      currency: null,
      problem: null,
    });
  });

  it("keeps the currency it read even when the amount is unclear", () => {
    expect(parsePriceText("from 20 €")).toMatchObject({
      minor: null,
      currency: "EUR",
      problem: "unreadable",
    });
    expect(parsePriceText("1.200 USD")).toMatchObject({
      minor: null,
      currency: "USD",
      problem: "ambiguous",
    });
  });

  it("does not read a currency out of the middle of a word", () => {
    expect(parsePriceText("12 Teur")).toMatchObject({
      minor: null,
      currency: null,
      problem: "unreadable",
    });
  });
});

describe("reading a currency", () => {
  it.each([
    ["€", "EUR"],
    ["EUR", "EUR"],
    ["eur", "EUR"],
    ["eur.", "EUR"],
    [" Eiro ", "EUR"],
    ["$", "USD"],
    ["usd", "USD"],
    ["gab", null],
    ["", null],
    ["constructor", null],
  ])("reads %j as %j", (token, currency) => {
    expect(currencyFromToken(token)).toBe(currency);
  });
});
