import { minorToDecimal } from "../domain/money";

// The review model shared by CSV and photo imports: what a draft row is, what stops it from being
// accepted, and what only asks for a second look. It decides from stored values, so the same rules
// apply however a row was read and however it was later edited.

export const MAX_ROWS_PER_IMPORT = 500;
export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_PRICE_TEXT_LENGTH = 60;
export const MAX_SOURCE_REF_LENGTH = 120;
export const MAX_DURATION_MINUTES = 7 * 24 * 60;

export type ProductKind = "product" | "service";

export type RowField =
  | "title"
  | "description"
  | "kind"
  | "price"
  | "currency"
  | "duration"
  | "deposit";

export type DraftRow = {
  position: number;
  sourceRef: string;
  title: string | null;
  kind: ProductKind | null;
  priceText: string | null;
  priceMinor: number | null;
  currency: string | null;
  serviceDurationMinutes: number | null;
  depositMinor: number | null;
  description: string | null;
  sourceWarnings: string[];
};

export type RowIssue = {
  code: string;
  field: RowField | null;
  severity: "blocker" | "warning";
  message: string;
};

type RowValues = Pick<
  DraftRow,
  | "title"
  | "kind"
  | "priceText"
  | "priceMinor"
  | "currency"
  | "serviceDurationMinutes"
  | "depositMinor"
  | "sourceWarnings"
>;

// What a seller is told about a doubt recorded when the row was read. The field says which edit
// settles it.
const SOURCE_WARNINGS: Record<string, { field: RowField | null; message: string }> = {
  uncertain_title: {
    field: "title",
    message: "The name was hard to read. Check it against your list.",
  },
  uncertain_description: {
    field: "description",
    message: "The description was hard to read. Check it against your list.",
  },
  uncertain_kind: {
    field: "kind",
    message: "It was not clear whether this is a product or a service.",
  },
  uncertain_price: {
    field: "price",
    message: "The price was hard to read. Check it against your list.",
  },
  uncertain_currency: {
    field: "currency",
    message: "The currency was hard to read. Check it against your list.",
  },
  uncertain_duration: {
    field: "duration",
    message: "The duration was hard to read. Check it against your list.",
  },
  row_cell_count: {
    field: "price",
    message:
      "This row has more cells than the file has columns, often from a comma in a price, so the price was not read from it.",
  },
  currency_conflict: {
    field: "currency",
    message: "Your list gives two different currencies for this row.",
  },
  duration_unreadable: {
    field: "duration",
    message: "The duration could not be read. Enter it in minutes.",
  },
  deposit_unreadable: {
    field: "deposit",
    message: "The deposit could not be read. Enter it as an amount.",
  },
  deposit_currency: {
    field: "deposit",
    message: "The deposit is in a different currency from this row, so it was not read. Enter it again.",
  },
  title_truncated: {
    field: "title",
    message: `The name was longer than ${MAX_TITLE_LENGTH} characters and was shortened.`,
  },
  description_truncated: {
    field: "description",
    message: `The description was longer than ${MAX_DESCRIPTION_LENGTH} characters and was shortened.`,
  },
  suggestion_rejected: {
    field: null,
    message:
      "The suggested description added details this row does not state, so it was dropped.",
  },
};

export function warningsClearedBy(field: RowField): string[] {
  return Object.entries(SOURCE_WARNINGS)
    .filter(([, warning]) => warning.field === field)
    .map(([code]) => code);
}

function priceBlocker(row: RowValues): RowIssue {
  return {
    code: "price_missing",
    field: "price",
    severity: "blocker",
    message: row.priceText
      ? `"${row.priceText}" is not one clear price. Enter the price.`
      : "Your list shows no price. Enter the price.",
  };
}

export function rowIssues(row: RowValues, shopCurrency: string): RowIssue[] {
  const issues: RowIssue[] = [];
  const blocker = (code: string, field: RowField, message: string) =>
    issues.push({ code, field, severity: "blocker", message });

  if (!row.title?.trim()) {
    blocker("title_missing", "title", "Enter a name.");
  }
  if (!row.kind) {
    blocker("kind_missing", "kind", "Choose product or service.");
  }
  if (row.priceMinor === null) {
    issues.push(priceBlocker(row));
  }
  if (row.currency === null) {
    blocker("currency_missing", "currency", "Your list shows no currency. Choose one.");
  } else if (row.currency !== shopCurrency) {
    blocker(
      "currency_mismatch",
      "currency",
      `This shop sells in ${shopCurrency} and your list says ${row.currency}. Enter the price in ${shopCurrency}.`,
    );
  }
  if (row.kind === "service") {
    if (row.serviceDurationMinutes === null) {
      blocker("duration_missing", "duration", "A service needs a duration, so a slot can be booked.");
    }
    if (row.depositMinor === null) {
      blocker("deposit_missing", "deposit", "A service needs a deposit, which the buyer pays when booking.");
    } else if (row.priceMinor !== null && row.depositMinor > row.priceMinor) {
      blocker("deposit_too_high", "deposit", "The deposit cannot be more than the price.");
    }
  }

  for (const code of row.sourceWarnings) {
    const warning = SOURCE_WARNINGS[code];
    if (warning) {
      issues.push({ code, severity: "warning", ...warning });
    }
  }
  return issues;
}

export function hasBlocker(issues: readonly RowIssue[]): boolean {
  return issues.some((issue) => issue.severity === "blocker");
}

export const DUPLICATE_WARNING: RowIssue = {
  code: "duplicate_title",
  field: "title",
  severity: "warning",
  message: "Another row in this import has the same name.",
};

export function titleKey(title: string | null): string | null {
  const key = title?.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  return key ? key : null;
}

// Removes control characters and collapses whitespace in text taken from a source, and cuts it to
// a length the table can show. Reports whether anything was cut.
export function cleanSourceText(
  raw: string | null | undefined,
  maxLength: number,
): { text: string | null; truncated: boolean } {
  const text = (raw ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") {
    return { text: null, truncated: false };
  }
  if (text.length <= maxLength) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, maxLength).trimEnd(), truncated: true };
}

// A source's duration: "45", "45 min", "1 h", "1.5 h". Null if it does not say an exact number of
// minutes within a week.
export function parseDurationText(raw: string | null | undefined): number | null {
  const text = (raw ?? "").normalize("NFKC").trim().toLowerCase();
  const minutes = /^(\d{1,5})\s*(?:m|min|mins|minutes?|min[uū]tes?)?\.?$/u.exec(text);
  if (minutes) {
    return inDurationRange(Number(minutes[1]));
  }
  const hours = /^(\d{1,3})(?:[.,](\d{1,2}))?\s*(?:h|hr|hrs|hours?|st|stundas?)\.?$/u.exec(text);
  if (hours) {
    const fraction = Number(`0.${hours[2] ?? "0"}`);
    const total = Number(hours[1]) * 60 + fraction * 60;
    return Number.isInteger(total) ? inDurationRange(total) : null;
  }
  return null;
}

function inDurationRange(minutes: number): number | null {
  return minutes > 0 && minutes <= MAX_DURATION_MINUTES ? minutes : null;
}

// For display. Every currency a draft row can hold has two decimal places.
export function minorToText(minor: number | null): string | null {
  return minor === null ? null : minorToDecimal(minor, "EUR");
}
