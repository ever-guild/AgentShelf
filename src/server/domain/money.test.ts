import { describe, expect, it } from "vitest";

import {
  MAX_MINOR,
  decimalToMinor,
  isSupportedCurrency,
  minorToDecimal,
  multiplyMinor,
  sumMinor,
} from "./money";

const outOfRange = { code: "AMOUNT_OUT_OF_RANGE" };

describe("minor unit arithmetic", () => {
  it("multiplies and sums exactly", () => {
    expect(multiplyMinor(1999, 3)).toBe(5997);
    expect(sumMinor([10, 20])).toBe(30);
    expect(sumMinor([])).toBe(0);
  });

  it("gives exact amounts where floating-point arithmetic does not", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(minorToDecimal(sumMinor([10, 20]), "EUR")).toBe("0.30");
    expect(19.99 * 100).not.toBe(1999);
    expect(decimalToMinor("19.99", "EUR")).toBe(1999);
  });

  it("refuses fractional, negative and unsafe amounts", () => {
    expect(() => multiplyMinor(12.5, 2)).toThrow(
      expect.objectContaining(outOfRange),
    );
    expect(() => sumMinor([0.1, 0.2])).toThrow(
      expect.objectContaining(outOfRange),
    );
    expect(() => sumMinor([-1])).toThrow(expect.objectContaining(outOfRange));
    expect(() => multiplyMinor(Number.NaN, 1)).toThrow(
      expect.objectContaining(outOfRange),
    );
  });

  it("refuses totals the database column could not store", () => {
    expect(multiplyMinor(MAX_MINOR, 1)).toBe(MAX_MINOR);
    expect(() => multiplyMinor(MAX_MINOR, 2)).toThrow(
      expect.objectContaining(outOfRange),
    );
    expect(() => sumMinor([MAX_MINOR, 1])).toThrow(
      expect.objectContaining(outOfRange),
    );
  });
});

describe("decimal strings", () => {
  it.each([
    [1250, "12.50"],
    [5, "0.05"],
    [0, "0.00"],
    [100, "1.00"],
    [990, "9.90"],
  ])("formats %i as %s", (minor, decimal) => {
    expect(minorToDecimal(minor, "EUR")).toBe(decimal);
  });

  it.each([
    ["12.50", 1250],
    ["12.5", 1250],
    ["12", 1200],
    ["0.05", 5],
  ])("parses %s as %i", (decimal, minor) => {
    expect(decimalToMinor(decimal, "EUR")).toBe(minor);
  });

  it.each(["12.345", "1,50", "-1.00", "", "1e3", "abc", " 1.00", "99999999999.00"])(
    "refuses %j rather than rounding it",
    (decimal) => {
      expect(() => decimalToMinor(decimal, "EUR")).toThrow(
        expect.objectContaining(outOfRange),
      );
    },
  );

  it("round-trips every cent value", () => {
    for (let minor = 0; minor <= 20_000; minor += 1) {
      expect(decimalToMinor(minorToDecimal(minor, "EUR"), "EUR")).toBe(minor);
    }
  });
});

describe("currency support", () => {
  it("supports EUR only for now", () => {
    expect(isSupportedCurrency("EUR")).toBe(true);
    expect(isSupportedCurrency("USD")).toBe(false);
  });

  it("is not fooled by inherited object properties", () => {
    expect(isSupportedCurrency("toString")).toBe(false);
    expect(isSupportedCurrency("__proto__")).toBe(false);
  });

  it("refuses to convert an unsupported currency", () => {
    expect(() => minorToDecimal(100, "USD")).toThrow(
      expect.objectContaining({ code: "UNSUPPORTED_CURRENCY" }),
    );
    expect(() => decimalToMinor("1.00", "USD")).toThrow(
      expect.objectContaining({ code: "UNSUPPORTED_CURRENCY" }),
    );
  });
});
