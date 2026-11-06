import { describe, expect, it } from "vitest";

import type { ExtractedItem } from "../contracts/imports";
import { MAX_DURATION_MINUTES, MAX_TITLE_LENGTH } from "./draft-rows";
import {
  draftRowsFromExtraction,
  suggestionKeepsToFacts,
  tolerateEnumValues,
} from "./extraction";

const item = (overrides: Partial<ExtractedItem> = {}): ExtractedItem => ({
  sourceLocation: "Line 1",
  name: "Tempered glass",
  description: null,
  kind: "product",
  priceText: "9,90 €",
  currency: null,
  durationMinutes: null,
  variants: [],
  uncertain: [],
  ...overrides,
});

describe("turning a reading into draft rows", () => {
  it("takes the amount from the printed text, never from the model", () => {
    expect(draftRowsFromExtraction([item()])).toEqual([
      {
        position: 0,
        sourceRef: "Line 1",
        title: "Tempered glass",
        kind: "product",
        priceText: "9,90 €",
        priceMinor: 990,
        currency: "EUR",
        serviceDurationMinutes: null,
        depositMinor: null,
        description: null,
        sourceWarnings: [],
      },
    ]);
  });

  it.each(["from 20 €", "20-30", "1.200", "call us", "free", "0"])(
    "keeps the unclear price %j unknown",
    (priceText) => {
      const [row] = draftRowsFromExtraction([item({ priceText })]);
      expect(row.priceMinor).toBeNull();
      expect(row.priceText).toBe(priceText);
    },
  );

  it("keeps a price the model could not read unknown", () => {
    const [row] = draftRowsFromExtraction([item({ priceText: null })]);
    expect(row).toMatchObject({ priceMinor: null, priceText: null, title: "Tempered glass" });
  });

  it("keeps currency unknown when neither the price nor the model states one", () => {
    expect(draftRowsFromExtraction([item({ priceText: "9.90" })])[0].currency).toBeNull();
  });

  it("accepts a currency the model read from a heading", () => {
    expect(
      draftRowsFromExtraction([item({ priceText: "9.90", currency: "eur" })])[0].currency,
    ).toBe("EUR");
  });

  it("prefers the currency on the price and reports a conflict", () => {
    const [row] = draftRowsFromExtraction([item({ priceText: "9.90 €", currency: "USD" })]);
    expect(row.currency).toBe("EUR");
    expect(row.sourceWarnings).toContain("currency_conflict");
  });

  it("drops a currency that is not a code and flags it", () => {
    const [row] = draftRowsFromExtraction([item({ priceText: "9.90", currency: "euros" })]);
    expect(row.currency).toBeNull();
    expect(row.sourceWarnings).toContain("uncertain_currency");
  });

  it("makes each option its own row with its own price", () => {
    const rows = draftRowsFromExtraction([
      item({
        name: "Screen replacement",
        kind: "service",
        priceText: null,
        variants: [
          { label: "iPhone 13", priceText: "89 €" },
          { label: "iPhone 14", priceText: "99 €" },
        ],
      }),
      item({ name: "Cable", priceText: "5 €" }),
    ]);
    expect(rows.map((row) => [row.position, row.title, row.priceMinor])).toEqual([
      [0, "Screen replacement - iPhone 13", 8900],
      [1, "Screen replacement - iPhone 14", 9900],
      [2, "Cable", 500],
    ]);
  });

  it("gives an option with no price of its own the item's price", () => {
    const rows = draftRowsFromExtraction([
      item({
        name: "Case",
        priceText: "14 €",
        variants: [
          { label: "Black", priceText: null },
          { label: "Blue", priceText: "15 €" },
        ],
      }),
    ]);
    expect(rows.map((row) => row.priceMinor)).toEqual([1400, 1500]);
  });

  it("leaves an option's price unknown when nothing states one", () => {
    const rows = draftRowsFromExtraction([
      item({ priceText: null, variants: [{ label: "Black", priceText: null }] }),
    ]);
    expect(rows[0]).toMatchObject({ title: "Tempered glass - Black", priceMinor: null });
  });

  it("records what the model was unsure about", () => {
    const [row] = draftRowsFromExtraction([
      item({ uncertain: ["name", "price", "kind", "currency", "duration", "description"] }),
    ]);
    expect(row.sourceWarnings.sort()).toEqual([
      "uncertain_currency",
      "uncertain_description",
      "uncertain_duration",
      "uncertain_kind",
      "uncertain_price",
      "uncertain_title",
    ]);
  });

  it("keeps a duration only for something that may be a service, within range", () => {
    const duration = (overrides: Partial<ExtractedItem>) =>
      draftRowsFromExtraction([item(overrides)])[0];
    expect(duration({ kind: "service", durationMinutes: 45 }).serviceDurationMinutes).toBe(45);
    expect(duration({ kind: null, durationMinutes: 45 }).serviceDurationMinutes).toBe(45);
    expect(duration({ kind: "product", durationMinutes: 45 }).serviceDurationMinutes).toBeNull();
    for (const durationMinutes of [0, -5, 1.5, MAX_DURATION_MINUTES + 1]) {
      const row = duration({ kind: "service", durationMinutes });
      expect(row.serviceDurationMinutes).toBeNull();
      expect(row.sourceWarnings).toContain("duration_unreadable");
    }
  });

  it("never fills in a deposit", () => {
    expect(draftRowsFromExtraction([item({ kind: "service" })])[0].depositMinor).toBeNull();
  });

  it("skips an entry with neither a name nor a price", () => {
    const rows = draftRowsFromExtraction([
      item({ name: null, priceText: null }),
      item({ name: "  ", priceText: "  " }),
      item({ name: null, priceText: "5 €" }),
    ]);
    expect(rows.map((row) => [row.position, row.title, row.priceMinor])).toEqual([[0, null, 500]]);
  });

  it("cleans and cuts text from the source", () => {
    const [row] = draftRowsFromExtraction([
      item({ name: `A\u0007B ${"x".repeat(MAX_TITLE_LENGTH)}`, sourceLocation: "  " }),
    ]);
    expect(row.title?.startsWith("A B x")).toBe(true);
    expect(row.title?.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(row.sourceWarnings).toContain("title_truncated");
    expect(row.sourceRef).toBe("Photo");
  });
});

describe("tolerating odd enum values", () => {
  const tolerate = (entry: Record<string, unknown>) =>
    (tolerateEnumValues({ items: [entry] }) as { items: Record<string, unknown>[] }).items[0];

  it("accepts a different capitalization", () => {
    expect(tolerate({ kind: "Service", uncertain: ["PRICE"] })).toEqual({
      kind: "service",
      uncertain: ["price"],
    });
  });

  it("makes an invented kind unknown and flags it", () => {
    expect(tolerate({ kind: "goods", uncertain: [] })).toEqual({
      kind: null,
      uncertain: ["kind"],
    });
  });

  it("keeps a null kind", () => {
    expect(tolerate({ kind: null, uncertain: [] })).toEqual({ kind: null, uncertain: [] });
  });

  it("drops an invented flag", () => {
    expect(tolerate({ kind: "product", uncertain: ["vibes", "name", 3] })).toEqual({
      kind: "product",
      uncertain: ["name"],
    });
  });

  it("leaves a shape it does not recognise for validation to reject", () => {
    expect(tolerateEnumValues("text")).toBe("text");
    expect(tolerateEnumValues({ items: "x" })).toEqual({ items: "x" });
    expect(tolerateEnumValues({ items: [null, 1] })).toEqual({ items: [null, 1] });
    expect(tolerate({ kind: 5, uncertain: "x" })).toEqual({ kind: 5, uncertain: "x" });
  });
});

describe("checking a suggested description", () => {
  it("accepts text whose numbers are all in the row", () => {
    expect(
      suggestionKeepsToFacts("Screen replacement for iPhone 13, 9H glass.", ["iPhone 13", "9H glass"]),
    ).toBe(true);
    expect(suggestionKeepsToFacts("A sturdy cable.", ["Cable", null])).toBe(true);
  });

  it.each([
    "A 5000 mAh battery.",
    "Comes with a 2 year warranty.",
    "For iPhone 13 and iPhone 14.",
    "12 W fast charging.",
  ])("rejects a number the row does not contain: %j", (suggestion) => {
    expect(suggestionKeepsToFacts(suggestion, ["iPhone 13 cable", null])).toBe(false);
  });

  it("does not treat part of a number as the number", () => {
    expect(suggestionKeepsToFacts("For iPhone 1.", ["iPhone 13"])).toBe(false);
  });
});
