import { ServiceError } from "../errors";

// All money is integer minor units. These helpers are the only place that converts to or
// from a decimal string, and they do it on digits, without floating-point arithmetic.

// The upper bound of the Postgres `integer` columns that store these amounts.
export const MAX_MINOR = 2_147_483_647;

const CURRENCY_EXPONENTS = { EUR: 2 } as const;

export type SupportedCurrency = keyof typeof CURRENCY_EXPONENTS;

export function isSupportedCurrency(
  currency: string,
): currency is SupportedCurrency {
  return Object.hasOwn(CURRENCY_EXPONENTS, currency);
}

function exponentOf(currency: string): number {
  if (!isSupportedCurrency(currency)) {
    throw new ServiceError(
      "UNSUPPORTED_CURRENCY",
      `Currency ${currency} is not supported.`,
    );
  }
  return CURRENCY_EXPONENTS[currency];
}

function assertMinor(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MINOR) {
    throw new ServiceError(
      "AMOUNT_OUT_OF_RANGE",
      "The amount is outside the supported range.",
    );
  }
  return value;
}

export function multiplyMinor(unitMinor: number, quantity: number): number {
  assertMinor(unitMinor);
  assertMinor(quantity);
  return assertMinor(unitMinor * quantity);
}

export function sumMinor(amounts: readonly number[]): number {
  return amounts.reduce(
    (total, amount) => assertMinor(total + assertMinor(amount)),
    0,
  );
}

// 1250 EUR -> "12.50", the form PayPal expects in `amount.value`.
export function minorToDecimal(minor: number, currency: string): string {
  const exponent = exponentOf(currency);
  const digits = String(assertMinor(minor)).padStart(exponent + 1, "0");
  if (exponent === 0) {
    return digits;
  }
  const split = digits.length - exponent;
  return `${digits.slice(0, split)}.${digits.slice(split)}`;
}

// "12.50" EUR -> 1250. Rejects anything that is not exact in the currency's minor unit, so
// a tampered or malformed provider amount cannot be silently rounded into a match.
export function decimalToMinor(decimal: string, currency: string): number {
  const exponent = exponentOf(currency);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(decimal);
  if (!match || (match[2]?.length ?? 0) > exponent) {
    throw new ServiceError(
      "AMOUNT_OUT_OF_RANGE",
      "The amount is not a valid decimal in this currency.",
    );
  }
  const fraction = (match[2] ?? "").padEnd(exponent, "0");
  return assertMinor(Number(`${match[1]}${fraction}`));
}
