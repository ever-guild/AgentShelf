import {
  MAX_DESCRIPTION_LENGTH,
  MAX_ROWS_PER_IMPORT,
  MAX_TITLE_LENGTH,
  cleanSourceText,
  parseDurationText,
  type DraftRow,
  type ProductKind,
} from "./draft-rows";
import { currencyFromToken, parsePriceText } from "./price-text";

// A price list as a CSV file. This is deterministic: no model is involved, and the same file always
// gives the same rows. Problems with the file as a whole reject it with a message the seller can
// act on. A problem with one row keeps the row, so the seller can fix or remove it in the table.

export const MAX_CSV_BYTES = 1_000_000;

export type CsvResult =
  | { ok: true; rows: DraftRow[]; ignoredColumns: string[] }
  | { ok: false; message: string };

type Column =
  | "title"
  | "price"
  | "currency"
  | "description"
  | "kind"
  | "variant"
  | "duration"
  | "deposit";

const COLUMN_NAMES = new Map<string, Column>(
  (
    [
      ["title", ["name", "title", "product", "item", "service", "nosaukums", "prece", "pakalpojums"]],
      ["price", ["price", "cost", "cena"]],
      ["currency", ["currency", "valuta", "valūta"]],
      ["description", ["description", "desc", "details", "apraksts"]],
      ["kind", ["kind", "type", "veids", "tips"]],
      ["variant", ["variant", "variants", "option", "model", "modelis", "size", "izmers", "izmērs"]],
      ["duration", ["duration", "duration_minutes", "duration minutes", "minutes", "ilgums"]],
      ["deposit", ["deposit", "depozits", "depozīts", "avanss"]],
    ] as const
  ).flatMap(([column, names]) => names.map((name) => [name, column] as const)),
);

const KIND_VALUES = new Map<string, ProductKind>([
  ["product", "product"],
  ["goods", "product"],
  ["item", "product"],
  ["prece", "product"],
  ["service", "service"],
  ["repair", "service"],
  ["pakalpojums", "service"],
  ["remonts", "service"],
]);

type CsvRecord = { line: number; cells: string[] };

// RFC 4180 with the leniency real exports need: a quote inside an unquoted cell is just a character,
// as in 5" screen. An opening quote that never closes would swallow the rest of the file, so it is
// reported instead.
function readRecords(
  text: string,
  delimiter: string,
): { records: CsvRecord[] } | { unterminatedQuoteAtLine: number } {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let line = 1;
  let recordLine = 1;
  let quoted = false;
  let quoteLine = 1;
  let cellStarted = false;

  const endCell = () => {
    cells.push(cell);
    cell = "";
    cellStarted = false;
  };
  const endRecord = () => {
    endCell();
    records.push({ line: recordLine, cells });
    cells = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        if (character === "\n") {
          line += 1;
        }
        cell += character;
      }
    } else if (character === '"' && !cellStarted) {
      quoted = true;
      cellStarted = true;
      quoteLine = line;
    } else if (character === delimiter) {
      endCell();
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      endRecord();
      line += 1;
      recordLine = line;
    } else {
      cell += character;
      cellStarted = true;
    }
  }
  if (quoted) {
    return { unterminatedQuoteAtLine: quoteLine };
  }
  if (cell !== "" || cells.length > 0) {
    endRecord();
  }
  return { records };
}

function chooseDelimiter(text: string): string {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? "";
  const unquoted = firstLine.replace(/"[^"]*"/g, "");
  let best = ",";
  let bestCount = 0;
  // On a tie the comma loses, because a heading such as "Cena, €" can hold one.
  for (const candidate of [";", "\t", ","]) {
    const count = unquoted.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

// A price column can state its currency in the heading: "Price (EUR)", "Cena, €".
function readHeading(raw: string): { column: Column | null; currency: string | null } {
  const heading = raw.normalize("NFKC").trim().toLowerCase();
  const exact = COLUMN_NAMES.get(heading);
  if (exact) {
    return { column: exact, currency: null };
  }
  const priced = /^(price|cost|cena)\s*[,(/:-]?\s*([^\s,()/:-]+)\s*\)?$/u.exec(heading);
  if (priced) {
    const currency = currencyFromToken(priced[2]);
    if (currency) {
      return { column: "price", currency };
    }
  }
  const timed = /^(duration|ilgums)\s*[,(/:-]?\s*(min|mins|minutes|minūtes)\s*\)?$/u.exec(heading);
  if (timed) {
    return { column: "duration", currency: null };
  }
  return { column: null, currency: null };
}

const isBlank = (cells: readonly string[]) => cells.every((cell) => cell.trim() === "");

function readKind(
  cell: string | undefined,
  durationCell: string | undefined,
): ProductKind | null {
  const value = cell?.trim().toLowerCase() ?? "";
  if (value !== "") {
    return KIND_VALUES.get(value) ?? null;
  }
  // A price list usually has no such column. Something with a duration is booked, not bought.
  return durationCell?.trim() ? "service" : "product";
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

export function parsePriceListCsv(bytes: Uint8Array): CsvResult {
  if (bytes.length > MAX_CSV_BYTES) {
    return {
      ok: false,
      message: `This file is larger than ${MAX_CSV_BYTES / 1_000_000} MB. Split it into smaller files.`,
    };
  }
  const text = decodeText(bytes);
  if (text === null) {
    return {
      ok: false,
      message: 'This file is not readable text. In your spreadsheet, save it as "CSV UTF-8".',
    };
  }

  const delimiter = chooseDelimiter(text);
  const read = readRecords(text, delimiter);
  if ("unterminatedQuoteAtLine" in read) {
    return {
      ok: false,
      message: `Line ${read.unterminatedQuoteAtLine} opens a quote that never closes. Fix it and upload the file again.`,
    };
  }

  const records = read.records.filter((record) => !isBlank(record.cells));
  const header = records.shift();
  if (!header) {
    return { ok: false, message: "This file has no rows." };
  }

  const columns = new Map<Column, number>();
  const ignoredColumns: string[] = [];
  let headingCurrency: string | null = null;
  for (const [index, raw] of header.cells.entries()) {
    const { column, currency } = readHeading(raw);
    if (!column) {
      if (raw.trim()) {
        ignoredColumns.push(raw.trim().slice(0, 60));
      }
      continue;
    }
    if (columns.has(column)) {
      return {
        ok: false,
        message: `Two columns mean the same thing: "${raw.trim().slice(0, 60)}" and "${header.cells[columns.get(column) as number].trim().slice(0, 60)}". Keep one.`,
      };
    }
    columns.set(column, index);
    headingCurrency = currency ?? headingCurrency;
  }

  const missing = (["title", "price"] as const).filter((column) => !columns.has(column));
  if (missing.length > 0) {
    const names = missing.map((column) => (column === "title" ? "name" : column)).join(" and ");
    return {
      ok: false,
      message: `The first line must name the columns, and we could not find ${names}. Use headings such as name, price, currency, description, kind, variant, duration and deposit.`,
    };
  }

  if (records.length === 0) {
    return { ok: false, message: "This file has headings but no rows." };
  }
  if (records.length > MAX_ROWS_PER_IMPORT) {
    return {
      ok: false,
      message: `This file has ${records.length} rows, and the limit is ${MAX_ROWS_PER_IMPORT}. Split it into smaller files.`,
    };
  }

  const rows = records.map((record, position) =>
    toDraftRow(record, position, columns, header.cells.length, headingCurrency, delimiter),
  );
  return { ok: true, rows, ignoredColumns };
}

function toDraftRow(
  record: CsvRecord,
  position: number,
  columns: ReadonlyMap<Column, number>,
  headerLength: number,
  headingCurrency: string | null,
  delimiter: string,
): DraftRow {
  const cell = (column: Column) => {
    const index = columns.get(column);
    return index === undefined ? undefined : record.cells[index];
  };
  const warnings: string[] = [];

  const name = cleanSourceText(cell("title"), MAX_TITLE_LENGTH);
  const variant = cleanSourceText(cell("variant"), MAX_TITLE_LENGTH);
  const joined = name.text && variant.text ? `${name.text} - ${variant.text}` : name.text;
  const title = cleanSourceText(joined, MAX_TITLE_LENGTH);
  if (name.truncated || variant.truncated || title.truncated) {
    warnings.push("title_truncated");
  }

  const description = cleanSourceText(cell("description"), MAX_DESCRIPTION_LENGTH);
  if (description.truncated) {
    warnings.push("description_truncated");
  }

  // Cells past the header mean the columns no longer line up, usually an unquoted "12,50". Reading
  // the price cell would give 12 here, so the price is not read at all.
  const misaligned = record.cells.length > headerLength;
  const priceIndex = columns.get("price") as number;
  const priceSource = misaligned
    ? record.cells.slice(priceIndex).join(delimiter)
    : (record.cells[priceIndex] ?? "");
  const priceText = cleanSourceText(priceSource, 60).text;
  const parsed = misaligned ? null : parsePriceText(priceText);
  if (misaligned) {
    warnings.push("row_cell_count");
  }

  const currencyCell = cell("currency")?.trim() ?? "";
  const statedCurrency =
    currencyCell === ""
      ? null
      : (currencyFromToken(currencyCell) ??
        (/^[A-Za-z]{3}$/.test(currencyCell) ? currencyCell.toUpperCase() : null));
  if (currencyCell !== "" && statedCurrency === null) {
    warnings.push("uncertain_currency");
  }
  const priceCurrency = parsed?.currency ?? null;
  if (priceCurrency && statedCurrency && priceCurrency !== statedCurrency) {
    warnings.push("currency_conflict");
  }

  const durationCell = cell("duration");
  const serviceDurationMinutes = durationCell?.trim() ? parseDurationText(durationCell) : null;
  if (durationCell?.trim() && serviceDurationMinutes === null) {
    warnings.push("duration_unreadable");
  }

  const kind = readKind(cell("kind"), durationCell);
  const isProduct = kind === "product";

  const depositCell = cell("deposit");
  const deposit = depositCell?.trim() ? parsePriceText(depositCell) : null;
  if (deposit && deposit.problem && !isProduct) {
    warnings.push("deposit_unreadable");
  }

  return {
    position,
    sourceRef: `Row ${record.line}`,
    title: title.text,
    kind,
    priceText,
    priceMinor: parsed?.minor ?? null,
    currency: priceCurrency ?? statedCurrency ?? headingCurrency,
    serviceDurationMinutes: isProduct ? null : serviceDurationMinutes,
    depositMinor: isProduct ? null : (deposit?.minor ?? null),
    description: description.text,
    sourceWarnings: warnings,
  };
}
