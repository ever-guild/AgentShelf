import { ServiceError } from "../errors";
import { decimalToMinor } from "../domain/money";

// Turns a price as a person wrote it into integer minor units, for CSV cells, text read from a
// photo and what a seller types. It only accepts what has one meaning. "1.200" could be 1200 or
// 1.20, and "from 20" is not a price at all, so those stay unknown for the seller to settle rather
// than being guessed into a number that a buyer could later be charged.

export type PriceProblem =
  | "missing"
  | "unreadable"
  | "ambiguous"
  | "not_positive"
  | "too_large";

export type ParsedPrice =
  | { minor: number; currency: string | null; problem: null }
  | { minor: null; currency: string | null; problem: PriceProblem };

// Every currency named here has two decimal places, which is what the arithmetic below assumes.
// A price in any other currency reads as unreadable rather than as a wrong amount.
const CURRENCY_TOKENS = new Map([
  ["€", "EUR"],
  ["eur", "EUR"],
  ["euro", "EUR"],
  ["euros", "EUR"],
  ["eiro", "EUR"],
  ["$", "USD"],
  ["usd", "USD"],
  ["£", "GBP"],
  ["gbp", "GBP"],
  ["zł", "PLN"],
  ["pln", "PLN"],
  ["sek", "SEK"],
  ["nok", "NOK"],
  ["dkk", "DKK"],
  ["chf", "CHF"],
]);

const TOKEN_PATTERN = [...CURRENCY_TOKENS.keys()]
  .sort((a, b) => b.length - a.length)
  .map((token) => token.replace(/[$]/g, "\\$&"))
  .join("|");

const LEADING_TOKEN = new RegExp(`^(${TOKEN_PATTERN})\\.?\\s*(.*)$`, "iu");
const TRAILING_TOKEN = new RegExp(
  `^(.*?)\\s*(?<![\\p{L}])(${TOKEN_PATTERN})\\.?$`,
  "iu",
);

const NO_VALUE = /^(?:-+|–+|—+|\?+|n\/?a|tbd|nav)$/iu;

export function currencyFromToken(token: string): string | null {
  return CURRENCY_TOKENS.get(token.trim().replace(/\.$/, "").toLowerCase()) ?? null;
}

function splitCurrency(text: string): { amount: string; currency: string | null } {
  const leading = LEADING_TOKEN.exec(text);
  if (leading) {
    return { amount: leading[2], currency: currencyFromToken(leading[1]) };
  }
  const trailing = TRAILING_TOKEN.exec(text);
  if (trailing) {
    return { amount: trailing[1], currency: currencyFromToken(trailing[2]) };
  }
  return { amount: text, currency: null };
}

// Returns a plain "1200.50", or a problem. Group separators must be consistent groups of three.
function normalizeAmount(amount: string): string | "unreadable" | "ambiguous" {
  // "12,-" is how many European price lists write a whole amount.
  const whole = /^(.*\d)[.,]-{1,2}$/.exec(amount);
  const text = whole ? whole[1] : amount;
  const decimalAllowed = !whole;

  if (/^\d+$/.test(text)) {
    return text;
  }
  // One separator followed by exactly three digits is either a thousand or three decimals.
  if (/^\d+[.,]\d{3}$/.test(text)) {
    return "ambiguous";
  }
  const decimal = /^(\d+)[.,](\d{1,2})$/.exec(text);
  if (decimal) {
    return decimalAllowed ? `${decimal[1]}.${decimal[2]}` : "unreadable";
  }
  // "1 200", "1'200", "1.200.000". A space or apostrophe can only be grouping, and a repeated
  // point or comma can only be grouping.
  const grouped = /^(\d{1,3})([ .,'])(\d{3}(?:\2\d{3})*)$/.exec(text);
  if (grouped) {
    return `${grouped[1]}${grouped[3].split(grouped[2]).join("")}`;
  }
  // "1.200,50", "1,200.50", "1 200,50".
  const groupedDecimal = /^(\d{1,3})([ .,'])(\d{3}(?:\2\d{3})*)([.,])(\d{1,2})$/.exec(
    text,
  );
  if (groupedDecimal && groupedDecimal[2] !== groupedDecimal[4] && decimalAllowed) {
    const integer = `${groupedDecimal[1]}${groupedDecimal[3].split(groupedDecimal[2]).join("")}`;
    return `${integer}.${groupedDecimal[5]}`;
  }
  return "unreadable";
}

export function parsePriceText(raw: string | null | undefined): ParsedPrice {
  // NFKC turns the non-breaking and thin spaces that spreadsheets use into plain ones.
  const text = (raw ?? "").normalize("NFKC").trim();
  if (text === "" || NO_VALUE.test(text)) {
    return { minor: null, currency: null, problem: "missing" };
  }

  const { amount, currency } = splitCurrency(text);
  const normalized = normalizeAmount(amount.trim());
  if (normalized === "unreadable" || normalized === "ambiguous") {
    return { minor: null, currency, problem: normalized };
  }

  let minor: number;
  try {
    minor = decimalToMinor(normalized, "EUR");
  } catch (error) {
    if (error instanceof ServiceError) {
      return { minor: null, currency, problem: "too_large" };
    }
    throw error;
  }
  if (minor <= 0) {
    return { minor: null, currency, problem: "not_positive" };
  }
  return { minor, currency, problem: null };
}

const PROBLEM_MESSAGES: Record<PriceProblem, string> = {
  missing: "Enter a price.",
  unreadable: "Enter one amount, such as 12.50.",
  ambiguous:
    "This could be read two ways. Write it with two decimals, such as 1200.00 or 1.20.",
  not_positive: "A price has to be more than zero.",
  too_large: "This amount is too large.",
};

export function priceProblemMessage(problem: PriceProblem): string {
  return PROBLEM_MESSAGES[problem];
}
