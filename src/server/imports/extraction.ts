import { UNCERTAIN_FIELDS, type ExtractedItem } from "../contracts/imports";
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_DURATION_MINUTES,
  MAX_PRICE_TEXT_LENGTH,
  MAX_SOURCE_REF_LENGTH,
  MAX_TITLE_LENGTH,
  cleanSourceText,
  type DraftRow,
} from "./draft-rows";
import { parsePriceText } from "./price-text";

// Turns what a model read into draft rows, the same shape a CSV produces. It trusts nothing it is
// given: amounts come only from the deterministic parser, and a value that cannot be used becomes
// unknown. A model has no field for a deposit, because a deposit is the seller's decision.

const UNCERTAIN_WARNINGS: Record<ExtractedItem["uncertain"][number], string> = {
  name: "uncertain_title",
  description: "uncertain_description",
  kind: "uncertain_kind",
  price: "uncertain_price",
  currency: "uncertain_currency",
  duration: "uncertain_duration",
};

// An odd enum value should cost one field, not the whole list. A model may vary the capitalization,
// which the API documents, or return a word of its own. A kind it invents becomes unknown and is
// flagged, and only values the contract allows go on. Anything else is left for validation to judge.
export function tolerateEnumValues(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || !("items" in raw) || !Array.isArray(raw.items)) {
    return raw;
  }
  return {
    ...raw,
    items: raw.items.map((item: unknown) => {
      if (typeof item !== "object" || item === null) {
        return item;
      }
      const { kind, uncertain } = item as { kind?: unknown; uncertain?: unknown };
      const flags = Array.isArray(uncertain)
        ? uncertain.flatMap((field: unknown) => {
            const known = UNCERTAIN_FIELDS.find(
              (candidate) => typeof field === "string" && candidate === field.toLowerCase(),
            );
            return known ? [known] : [];
          })
        : uncertain;
      if (typeof kind !== "string") {
        return { ...item, uncertain: flags };
      }
      const lowered = kind.toLowerCase();
      if (lowered === "product" || lowered === "service") {
        return { ...item, kind: lowered, uncertain: flags };
      }
      return {
        ...item,
        kind: null,
        uncertain: Array.isArray(flags) ? [...flags, "kind"] : flags,
      };
    }),
  };
}

function readCurrency(raw: string | null): { currency: string | null; unreadable: boolean } {
  const code = raw?.trim().toUpperCase() ?? "";
  if (code === "") {
    return { currency: null, unreadable: false };
  }
  return /^[A-Z]{3}$/.test(code)
    ? { currency: code, unreadable: false }
    : { currency: null, unreadable: true };
}

function toDraftRow(
  item: ExtractedItem,
  variant: ExtractedItem["variants"][number] | null,
  position: number,
): DraftRow {
  const warnings = new Set(item.uncertain.map((field) => UNCERTAIN_WARNINGS[field]));

  const name = cleanSourceText(
    variant ? [item.name, variant.label].filter(Boolean).join(" - ") : item.name,
    MAX_TITLE_LENGTH,
  );
  if (name.truncated) {
    warnings.add("title_truncated");
  }
  const description = cleanSourceText(item.description, MAX_DESCRIPTION_LENGTH);
  if (description.truncated) {
    warnings.add("description_truncated");
  }

  const priceText = cleanSourceText(variant?.priceText ?? item.priceText, MAX_PRICE_TEXT_LENGTH).text;
  const price = parsePriceText(priceText);

  const stated = readCurrency(item.currency);
  if (stated.unreadable) {
    warnings.add("uncertain_currency");
  }
  if (price.currency && stated.currency && price.currency !== stated.currency) {
    warnings.add("currency_conflict");
  }

  const duration = item.durationMinutes;
  const durationInRange =
    duration !== null &&
    Number.isInteger(duration) &&
    duration > 0 &&
    duration <= MAX_DURATION_MINUTES;
  if (duration !== null && !durationInRange) {
    warnings.add("duration_unreadable");
  }

  return {
    position,
    sourceRef: cleanSourceText(item.sourceLocation, MAX_SOURCE_REF_LENGTH).text ?? "Photo",
    title: name.text,
    kind: item.kind,
    priceText,
    priceMinor: price.minor,
    currency: price.currency ?? stated.currency,
    serviceDurationMinutes: item.kind !== "product" && durationInRange ? duration : null,
    depositMinor: null,
    description: description.text,
    sourceWarnings: [...warnings],
  };
}

// A priced option becomes a row of its own, because a product has one price and an order line names
// one product. An entry with neither a name nor a price gives a seller nothing to act on.
export function draftRowsFromExtraction(items: readonly ExtractedItem[]): DraftRow[] {
  const rows: DraftRow[] = [];
  for (const item of items) {
    const options = item.variants.length > 0 ? item.variants : [null];
    for (const option of options) {
      const row = toDraftRow(item, option, rows.length);
      if (row.title !== null || row.priceText !== null) {
        rows.push(row);
      }
    }
  }
  return rows;
}

// A suggested description may only restate a row, so a number that the row does not contain, such
// as "5000 mAh" or "2 year warranty", means the suggestion invented a specification. This does not
// catch every invention. It catches the checkable ones, and a person reads the rest.
export function suggestionKeepsToFacts(suggestion: string, facts: readonly (string | null)[]): boolean {
  const known = new Set(facts.flatMap((fact) => fact?.match(/\d+/g) ?? []));
  return (suggestion.match(/\d+/g) ?? []).every((number) => known.has(number));
}
