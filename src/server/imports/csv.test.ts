import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MAX_CSV_BYTES, parsePriceListCsv } from "./csv";
import { MAX_ROWS_PER_IMPORT, MAX_TITLE_LENGTH } from "./draft-rows";

const parse = (text: string) => parsePriceListCsv(Buffer.from(text, "utf8"));

function rowsOf(text: string) {
  const result = parse(text);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.rows;
}

function messageOf(text: string | Uint8Array) {
  const result = typeof text === "string" ? parse(text) : parsePriceListCsv(text);
  if (result.ok) {
    throw new Error("Expected the file to be rejected");
  }
  return result.message;
}

describe("reading a readable CSV", () => {
  it("gives one draft row per line, with exact amounts and where it came from", () => {
    const rows = rowsOf(
      "name,price,currency,description\nTempered glass,9.90,EUR,9H glass\nUSB-C cable,14.50,EUR,\n",
    );
    expect(rows).toEqual([
      {
        position: 0,
        sourceRef: "Row 2",
        title: "Tempered glass",
        kind: "product",
        priceText: "9.90",
        priceMinor: 990,
        currency: "EUR",
        serviceDurationMinutes: null,
        depositMinor: null,
        description: "9H glass",
        sourceWarnings: [],
      },
      {
        position: 1,
        sourceRef: "Row 3",
        title: "USB-C cable",
        kind: "product",
        priceText: "14.50",
        priceMinor: 1450,
        currency: "EUR",
        serviceDurationMinutes: null,
        depositMinor: null,
        description: null,
        sourceWarnings: [],
      },
    ]);
  });

  it("is deterministic", () => {
    const text = "name,price\nCable,5\nCharger,12.5\n";
    expect(rowsOf(text)).toEqual(rowsOf(text));
  });

  it("reads the checked-in sample", () => {
    const result = parsePriceListCsv(
      readFileSync("test/fixtures/price-lists/phone-workshop.csv"),
    );
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.rows.length).toBeGreaterThan(4);
    expect(result.rows.filter((row) => row.kind === "service").length).toBeGreaterThan(0);
    expect(result.rows.every((row) => row.priceMinor && row.currency === "EUR")).toBe(true);
    expect(result.rows.every((row) => row.sourceWarnings.length === 0)).toBe(true);
  });

  it("reads a spreadsheet's semicolons, decimal commas, BOM and Latvian headings", () => {
    const rows = rowsOf(
      "﻿Nosaukums;Cena;Valūta;Apraksts\r\nEkrāna stikls;9,90;EUR;Rūdīts stikls\r\nLādētājs;1 200,50 €;;\r\n",
    );
    expect(rows.map((row) => [row.title, row.priceMinor, row.currency, row.description])).toEqual([
      ["Ekrāna stikls", 990, "EUR", "Rūdīts stikls"],
      ["Lādētājs", 120050, "EUR", null],
    ]);
  });

  it("reads tabs", () => {
    expect(rowsOf("name\tprice\nCable\t5\n")[0]).toMatchObject({
      title: "Cable",
      priceMinor: 500,
    });
  });

  it("takes a currency from the price column's heading", () => {
    expect(rowsOf("Name,Price (EUR)\nCable,5\n")[0].currency).toBe("EUR");
    expect(rowsOf("Name;Cena, €\nCable;5\n")[0].currency).toBe("EUR");
  });

  it("prefers the currency written on the row over the heading", () => {
    expect(rowsOf("Name,Price (EUR)\nCable,5 USD\n")[0].currency).toBe("USD");
  });

  it("handles quoted cells, escaped quotes, line breaks and quotes inside plain cells", () => {
    const rows = rowsOf(
      'name,price,description\n"Case, black",5,"Fits ""Pro"" models"\n"Two\nlines",6,\n5" screen,7,\n',
    );
    expect(rows.map((row) => [row.title, row.priceMinor, row.sourceRef])).toEqual([
      ["Case, black", 500, "Row 2"],
      ["Two lines", 600, "Row 3"],
      ['5" screen', 700, "Row 5"],
    ]);
    expect(rows[0].description).toBe('Fits "Pro" models');
  });

  it("numbers rows by their line in the file, skipping blank lines", () => {
    expect(rowsOf("name,price\n\nCable,5\n,,\nCharger,6\n").map((row) => row.sourceRef)).toEqual([
      "Row 3",
      "Row 5",
    ]);
  });

  it("reads a file with no final line break and old Mac line endings", () => {
    expect(rowsOf("name,price\rCable,5\rCharger,6").map((row) => row.priceMinor)).toEqual([
      500, 600,
    ]);
  });

  it("makes a variant its own row, because a product has one price", () => {
    const rows = rowsOf(
      "name,variant,price\nScreen replacement,iPhone 13,89\nScreen replacement,iPhone 14,99\n",
    );
    expect(rows.map((row) => [row.title, row.priceMinor])).toEqual([
      ["Screen replacement - iPhone 13", 8900],
      ["Screen replacement - iPhone 14", 9900],
    ]);
  });

  it("reports the columns it did not use", () => {
    const result = parse("name,price,stock,supplier\nCable,5,3,Acme\n");
    expect(result).toMatchObject({ ok: true, ignoredColumns: ["stock", "supplier"] });
  });
});

describe("kinds and service terms", () => {
  it("reads kinds in English and Latvian", () => {
    const rows = rowsOf(
      "name,price,kind\nA,1,product\nB,1,Service\nC,1,pakalpojums\nD,1,prece\nE,1,remonts\n",
    );
    expect(rows.map((row) => row.kind)).toEqual([
      "product",
      "service",
      "service",
      "product",
      "service",
    ]);
  });

  it("leaves an unknown kind unknown instead of guessing", () => {
    expect(rowsOf("name,price,kind\nA,1,gadget\n")[0].kind).toBeNull();
  });

  it("treats a row with a duration as a service when no kind is given", () => {
    const rows = rowsOf("name,price,duration\nRepair,80,45\nCable,5,\n");
    expect(rows.map((row) => [row.kind, row.serviceDurationMinutes])).toEqual([
      ["service", 45],
      ["product", null],
    ]);
  });

  it.each([
    ["45", 45],
    ["45 min", 45],
    ["1 h", 60],
    ["1.5 h", 90],
    ["2 st", 120],
  ])("reads the duration %j", (cell, minutes) => {
    expect(rowsOf(`name,price,duration\nRepair,80,${cell}\n`)[0].serviceDurationMinutes).toBe(minutes);
  });

  it.each(["soon", "0", "-5", "1.333 h", "99999", "1 week"])(
    "flags the duration %j rather than guessing",
    (cell) => {
      const [row] = rowsOf(`name,price,kind,duration\nRepair,80,service,${cell}\n`);
      expect(row.serviceDurationMinutes).toBeNull();
      expect(row.sourceWarnings).toContain("duration_unreadable");
    },
  );

  it("reads a service's deposit", () => {
    const [row] = rowsOf("name,price,kind,duration,deposit\nRepair,80,service,45,20\n");
    expect(row).toMatchObject({ kind: "service", depositMinor: 2000, serviceDurationMinutes: 45 });
  });

  it("flags an unreadable deposit", () => {
    const [row] = rowsOf("name,price,kind,duration,deposit\nRepair,80,service,45,half\n");
    expect(row.depositMinor).toBeNull();
    expect(row.sourceWarnings).toContain("deposit_unreadable");
  });

  it("drops service terms from a product row", () => {
    const [row] = rowsOf("name,price,kind,duration,deposit\nCable,5,product,45,2\n");
    expect(row).toMatchObject({ serviceDurationMinutes: null, depositMinor: null });
  });
});

describe("rows that need a person", () => {
  it.each([
    ["from 20", "from 20"],
    ["20-30", "20-30"],
    ["1.200", "1.200"],
    ["free", "free"],
    ["0", "0"],
  ])("keeps the unclear price %j unknown and remembers what it said", (cell, text) => {
    const [row] = rowsOf(`name,price\nCable,${cell}\n`);
    expect(row.priceMinor).toBeNull();
    expect(row.priceText).toBe(text);
  });

  it("keeps a missing price unknown", () => {
    const [row] = rowsOf("name,price\nCable,\n");
    expect(row).toMatchObject({ priceMinor: null, priceText: null });
  });

  it("keeps a row with no name, so it can be fixed or removed", () => {
    expect(rowsOf("name,price\n,5\n")[0]).toMatchObject({ title: null, priceMinor: 500 });
  });

  it("does not read 12 out of an unquoted 12,50", () => {
    const [row] = rowsOf("name,price\nCable,12,50\n");
    expect(row.priceMinor).toBeNull();
    expect(row.priceText).toBe("12,50");
    expect(row.sourceWarnings).toContain("row_cell_count");
  });

  it("does not trust a price on a row with extra cells before it", () => {
    const [row] = rowsOf("name,price\nCase, black,5\n");
    expect(row.priceMinor).toBeNull();
    expect(row.sourceWarnings).toContain("row_cell_count");
  });

  it("treats a short row as having empty cells", () => {
    const [row] = rowsOf("name,price,description\nCable,5\n");
    expect(row).toMatchObject({ priceMinor: 500, description: null, sourceWarnings: [] });
  });

  it("leaves currency unknown when the source does not state it", () => {
    expect(rowsOf("name,price\nCable,5\n")[0].currency).toBeNull();
  });

  it("reports two currencies for one row", () => {
    const [row] = rowsOf("name,price,currency\nCable,5 USD,EUR\n");
    expect(row.sourceWarnings).toContain("currency_conflict");
  });

  it("flags a currency it cannot read", () => {
    const [row] = rowsOf("name,price,currency\nCable,5,euros please\n");
    expect(row.currency).toBeNull();
    expect(row.sourceWarnings).toContain("uncertain_currency");
  });

  it("cuts an over-long name and says so", () => {
    const [row] = rowsOf(`name,price\n${"x".repeat(MAX_TITLE_LENGTH + 5)},5\n`);
    expect(row.title).toHaveLength(MAX_TITLE_LENGTH);
    expect(row.sourceWarnings).toContain("title_truncated");
  });

  it("removes control characters from text", () => {
    expect(rowsOf("name,price\n\"Ca\u0007ble\u001b\",5\n")[0].title).toBe("Ca ble");
  });

  it("reads the checked-in ambiguous sample without inventing a price", () => {
    const result = parsePriceListCsv(readFileSync("test/fixtures/price-lists/ambiguous.csv"));
    if (!result.ok) {
      throw new Error(result.message);
    }
    expect(result.rows.filter((row) => row.priceMinor === null).length).toBeGreaterThan(3);
  });
});

describe("rejecting a file with a useful message", () => {
  it("reads the checked-in malformed sample", () => {
    expect(messageOf(readFileSync("test/fixtures/price-lists/malformed.csv"))).toMatch(/quote/);
  });

  it("names the missing columns", () => {
    expect(messageOf("title,stock\nCable,5\n")).toMatch(/could not find price/);
    expect(messageOf("foo,bar\n1,2\n")).toMatch(/could not find name and price/);
  });

  it("explains a file with no header row", () => {
    expect(messageOf("Cable,5\nCharger,6\n")).toMatch(/first line must name the columns/);
  });

  it("names a repeated column", () => {
    expect(messageOf("name,price,cena\nCable,5,6\n")).toMatch(/"cena" and "price"/);
  });

  it("explains an empty file and a file with only headings", () => {
    expect(messageOf("\n\n")).toMatch(/no rows/);
    expect(messageOf("name,price\n")).toMatch(/no rows/);
  });

  it("points at a quote that never closes", () => {
    expect(messageOf('name,price\nCable,5\n"Charger,6\nCase,7\n')).toMatch(/^Line 3 opens a quote/);
  });

  it("rejects too many rows, saying how many", () => {
    const lines = Array.from({ length: MAX_ROWS_PER_IMPORT + 1 }, () => "Cable,5").join("\n");
    expect(messageOf(`name,price\n${lines}\n`)).toContain(String(MAX_ROWS_PER_IMPORT + 1));
  });

  it("accepts exactly the row limit", () => {
    const lines = Array.from({ length: MAX_ROWS_PER_IMPORT }, () => "Cable,5").join("\n");
    expect(rowsOf(`name,price\n${lines}\n`)).toHaveLength(MAX_ROWS_PER_IMPORT);
  });

  it("rejects a file over the size limit", () => {
    expect(messageOf(Buffer.alloc(MAX_CSV_BYTES + 1, "a"))).toMatch(/larger than 1 MB/);
  });

  it("rejects text that is not UTF-8, saying how to fix it", () => {
    const latin1 = Buffer.from("name,price\nCaf\xe9,5\n", "latin1");
    expect(messageOf(latin1)).toMatch(/CSV UTF-8/);
  });

  it("rejects binary content", () => {
    expect(messageOf(Buffer.from([0x6e, 0x61, 0x00, 0x6d, 0x65]))).toMatch(/CSV UTF-8/);
  });
});
