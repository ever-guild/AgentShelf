import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import { createProduct, createShop, violatedConstraint } from "../../../test/fixtures";
import {
  JPEG,
  PNG,
  createImportHarness,
  extractedItem,
  fixture,
  jobRow,
  readableCsv,
  rowsOf,
  sourceOf,
} from "../../../test/imports";
import { AiFailure } from "../ai/types";
import { importJobs, importRows, products } from "../db/schema";
import { runImportJob } from "./import-run";
import type { ImportDeps } from "./import-start";
import {
  MAX_IMAGE_BYTES,
  applyBulkAction,
  createImport,
  finishImportReview,
  getImport,
  listImports,
  readImportSource,
  retryImport,
  suggestDescriptions,
  updateImportRow,
} from "./imports";
import { searchProducts } from "./catalog";

const getDb = setupMigratedDatabase();

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorLog.mockRestore();
});

const code = (expected: string) => expect.objectContaining({ code: expected });

async function csvImport(csv: string | Buffer = readableCsv(), shopOverrides = {}) {
  const shop = await createShop(getDb(), shopOverrides);
  const harness = createImportHarness();
  const view = await createImport(
    getDb(),
    shop,
    { name: "prices.csv", bytes: typeof csv === "string" ? Buffer.from(csv) : csv },
    harness.deps,
  );
  return { shop, view, jobId: view.id, ...harness };
}

async function photoImport() {
  const shop = await createShop(getDb());
  const harness = createImportHarness();
  const view = await createImport(getDb(), shop, { name: "prices.jpg", bytes: JPEG }, harness.deps);
  return { shop, view, jobId: view.id, ...harness };
}

describe("uploading a CSV", () => {
  it("goes straight to review, with no model and no background run", async () => {
    const { view, started, model, jobId } = await csvImport();
    expect(view).toMatchObject({
      sourceKind: "csv",
      sourceName: "prices.csv",
      status: "needs_review",
      model: null,
      promptVersion: null,
      hasSource: false,
      counts: { total: 2, blocked: 0, pending: 2, accepted: 0, removed: 0 },
    });
    expect(view.rows.map((row) => [row.title, row.price, row.currency, row.status])).toEqual([
      ["Tempered glass", "9.90", "EUR", "pending"],
      ["USB-C cable", "7.50", "EUR", "pending"],
    ]);
    expect(started).toEqual([]);
    expect(model.images).toEqual([]);
    expect(await sourceOf(getDb(), jobId)).toBeUndefined();
  });

  it("works with no model configured", async () => {
    const shop = await createShop(getDb());
    const deps: ImportDeps = { ai: undefined, startRun: async () => {} };
    const view = await createImport(getDb(), shop, { name: "a.csv", bytes: readableCsv() }, deps);
    expect(view.status).toBe("needs_review");
  });

  it("reads the checked-in sample end to end", async () => {
    const { view } = await csvImport(fixture("phone-workshop.csv"));
    expect(view.counts).toMatchObject({ total: 7 });
    // The sample is complete, so nothing stands between it and being accepted.
    expect(view.rows.flatMap((row) => row.issues)).toEqual([]);
  });

  it("says which columns it did not use", async () => {
    const { view } = await csvImport("name,price,stock\nCable,5,3\n");
    expect(view.ignoredColumns).toEqual(["stock"]);
  });

  it("rejects a malformed file with a useful message and stores nothing", async () => {
    const shop = await createShop(getDb());
    const { deps } = createImportHarness();
    await expect(
      createImport(getDb(), shop, { name: "a.csv", bytes: fixture("malformed.csv") }, deps),
    ).rejects.toMatchObject({
      code: "IMPORT_FILE_INVALID",
      message: expect.stringContaining("quote"),
    });
    expect(await listImports(getDb(), shop)).toEqual([]);
  });
});

describe("uploading a photo", () => {
  it("stores the file with an expiry, and starts one run", async () => {
    const { view, jobId, started } = await photoImport();
    expect(view).toMatchObject({ sourceKind: "photo", status: "queued", hasSource: true, rows: [] });
    expect(started.map((job) => job.id)).toEqual([jobId]);

    const source = await sourceOf(getDb(), jobId);
    expect(source.mediaType).toBe("image/jpeg");
    expect(source.bytes.equals(JPEG)).toBe(true);
    const hoursLeft = (source.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hoursLeft).toBeGreaterThan(71.9);
    expect(hoursLeft).toBeLessThanOrEqual(72);
  });

  it("decides the type from the bytes, not the name", async () => {
    const shop = await createShop(getDb());
    const { deps } = createImportHarness();
    const named = await createImport(getDb(), shop, { name: "list.csv", bytes: PNG }, deps);
    expect((await sourceOf(getDb(), named.id)).mediaType).toBe("image/png");
    await expect(
      createImport(getDb(), shop, { name: "photo.jpg", bytes: Buffer.from("name,price\n") }, deps),
    ).rejects.toEqual(code("IMPORT_FILE_UNSUPPORTED"));
  });

  it.each([
    ["HEIC", Buffer.concat([Buffer.alloc(4), Buffer.from("ftypheic")]), /Export it as JPEG/],
    ["GIF", Buffer.from("GIF89a"), /GIF images are not supported/],
    ["PDF", Buffer.from("%PDF-1.7"), /PDF files are not supported/],
    ["Excel", Buffer.from([0x50, 0x4b, 0x03, 0x04]), /Save it as CSV/],
    ["old Excel", Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), /Save it as CSV/],
    ["an empty file", Buffer.alloc(0), /empty/],
    ["an unknown type", Buffer.from("MZ binary"), /JPEG, PNG or WebP/],
  ])("explains why %s is refused", async (_name, bytes, message) => {
    const shop = await createShop(getDb());
    const { deps, started } = createImportHarness();
    await expect(
      createImport(getDb(), shop, { name: "file.bin", bytes }, deps),
    ).rejects.toMatchObject({ code: "IMPORT_FILE_UNSUPPORTED", message: expect.stringMatching(message) });
    expect(started).toEqual([]);
    expect(await listImports(getDb(), shop)).toEqual([]);
  });

  it("accepts WebP", async () => {
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
    const shop = await createShop(getDb());
    const view = await createImport(
      getDb(),
      shop,
      { name: "a.webp", bytes: webp },
      createImportHarness().deps,
    );
    expect((await sourceOf(getDb(), view.id)).mediaType).toBe("image/webp");
  });

  it("enforces the size limit exactly", async () => {
    const shop = await createShop(getDb());
    const { deps } = createImportHarness();
    const ofSize = (size: number) => Buffer.concat([JPEG, Buffer.alloc(size - JPEG.length)]);
    await expect(
      createImport(getDb(), shop, { name: "a.jpg", bytes: ofSize(MAX_IMAGE_BYTES + 1) }, deps),
    ).rejects.toEqual(code("IMPORT_FILE_TOO_LARGE"));
    await expect(
      createImport(getDb(), shop, { name: "a.jpg", bytes: ofSize(MAX_IMAGE_BYTES) }, deps),
    ).resolves.toMatchObject({ status: "queued" });
  });

  it("is refused with a clear message when no model is configured", async () => {
    const shop = await createShop(getDb());
    const deps: ImportDeps = { ai: undefined, startRun: async () => {} };
    await expect(
      createImport(getDb(), shop, { name: "a.jpg", bytes: JPEG }, deps),
    ).rejects.toMatchObject({
      code: "IMPORT_NOT_CONFIGURED",
      message: expect.stringContaining("CSV"),
    });
    expect(await listImports(getDb(), shop)).toEqual([]);
  });

  it("keeps the upload when a run cannot be started, for the sweep to pick up", async () => {
    const shop = await createShop(getDb());
    const { model } = createImportHarness();
    const deps: ImportDeps = {
      ai: model.ai,
      startRun: async () => {
        throw new Error("SECRET render detail");
      },
    };
    const view = await createImport(getDb(), shop, { name: "a.jpg", bytes: JPEG }, deps);
    expect(view.status).toBe("queued");
    expect(await sourceOf(getDb(), view.id)).toBeDefined();
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("SECRET");
  });

  it("limits how many photos can wait, per shop", async () => {
    const shop = await createShop(getDb());
    const { deps } = createImportHarness();
    const upload = () => createImport(getDb(), shop, { name: "a.jpg", bytes: JPEG }, deps);
    await upload();
    await upload();
    await upload();
    await expect(upload()).rejects.toEqual(code("IMPORT_LIMIT_REACHED"));

    // Another shop and a CSV are unaffected.
    const other = await createShop(getDb());
    await expect(
      createImport(getDb(), other, { name: "a.jpg", bytes: JPEG }, deps),
    ).resolves.toMatchObject({ status: "queued" });
    await expect(
      createImport(getDb(), shop, { name: "a.csv", bytes: readableCsv() }, deps),
    ).resolves.toMatchObject({ status: "needs_review" });
  });

  it("limits how many photos a shop can read in a day", async () => {
    const shop = await createShop(getDb());
    const { deps } = createImportHarness();
    await getDb()
      .insert(importJobs)
      .values(
        Array.from({ length: 30 }, () => ({
          shopId: shop.id,
          sourceKind: "photo" as const,
          status: "needs_review" as const,
        })),
      );
    await expect(
      createImport(getDb(), shop, { name: "a.jpg", bytes: JPEG }, deps),
    ).rejects.toEqual(code("IMPORT_LIMIT_REACHED"));

    // Yesterday's do not count.
    await getDb()
      .update(importJobs)
      .set({ createdAt: sql`now() - interval '25 hours'` })
      .where(eq(importJobs.shopId, shop.id));
    await expect(
      createImport(getDb(), shop, { name: "a.jpg", bytes: JPEG }, deps),
    ).resolves.toMatchObject({ status: "queued" });
  });

  it("keeps only the file's own name, cleaned", async () => {
    const shop = await createShop(getDb());
    const { deps } = createImportHarness();
    const view = await createImport(
      getDb(),
      shop,
      { name: "../../etc/pass\u0007wd.csv", bytes: readableCsv() },
      deps,
    );
    expect(view.sourceName).toBe("passwd.csv");
  });
});

describe("the review gate", () => {
  const missingPriceCsv = "name,price,currency\nCable,5,EUR\nCharger,,EUR\n";
  const unreadablePriceCsv = "name,price,currency\nCable,5,EUR\nRepair,from 20,EUR\n";

  async function accept(shop: { id: string; currency: string }, jobId: string, rowId: string) {
    return updateImportRow(getDb(), shop, jobId, rowId, { status: "accepted" });
  }

  it("marks a row with no price as blocked and says why", async () => {
    const { view } = await csvImport(missingPriceCsv);
    expect(view.counts.blocked).toBe(1);
    expect(view.rows[1].issues).toEqual([
      expect.objectContaining({
        code: "price_missing",
        severity: "blocker",
        field: "price",
        message: "Your list shows no price. Enter the price.",
      }),
    ]);
  });

  it("marks an unreadable price as blocked and quotes what the source said", async () => {
    const { view } = await csvImport(unreadablePriceCsv);
    expect(view.rows[1].priceText).toBe("from 20");
    expect(view.rows[1].price).toBeNull();
    expect(view.rows[1].issues[0].message).toContain('"from 20"');
  });

  it("refuses to accept a row until its price is corrected, then accepts it", async () => {
    const { shop, view, jobId } = await csvImport(missingPriceCsv);
    const row = view.rows[1];

    await expect(accept(shop, jobId, row.id)).rejects.toMatchObject({
      code: "IMPORT_ROW_BLOCKED",
      details: { issues: [{ code: "price_missing", field: "price" }] },
    });
    expect((await rowsOf(getDb(), jobId))[1].status).toBe("pending");

    await updateImportRow(getDb(), shop, jobId, row.id, { price: "14.50" });
    const accepted = await accept(shop, jobId, row.id);
    expect(accepted.rows[1]).toMatchObject({ price: "14.50", status: "accepted", issues: [] });
  });

  it("blocks finishing, and so publication, until every row is decided", async () => {
    const { shop, view, jobId } = await csvImport(missingPriceCsv);
    await accept(shop, jobId, view.rows[0].id);

    await expect(finishImportReview(getDb(), shop, jobId)).rejects.toMatchObject({
      code: "IMPORT_REVIEW_INCOMPLETE",
      details: { rows: [{ id: view.rows[1].id, sourceRef: "Row 3" }] },
    });
    expect((await jobRow(getDb(), jobId)).status).toBe("needs_review");

    await updateImportRow(getDb(), shop, jobId, view.rows[1].id, { price: "14.50", status: "accepted" });
    const finished = await finishImportReview(getDb(), shop, jobId);
    expect(finished.status).toBe("completed");
    expect((await rowsOf(getDb(), jobId)).map((row) => [row.status, row.priceMinor])).toEqual([
      ["accepted", 500],
      ["accepted", 1450],
    ]);
  });

  it("lets a seller remove a bad row and finish without it", async () => {
    const { shop, view, jobId } = await csvImport(missingPriceCsv);
    await accept(shop, jobId, view.rows[0].id);
    await updateImportRow(getDb(), shop, jobId, view.rows[1].id, { status: "removed" });
    const finished = await finishImportReview(getDb(), shop, jobId);
    expect(finished).toMatchObject({
      status: "completed",
      counts: { accepted: 1, removed: 1, pending: 0, blocked: 0 },
    });
  });

  it("requires at least one accepted row", async () => {
    const { shop, view, jobId } = await csvImport("name,price\nCable,5\n");
    await updateImportRow(getDb(), shop, jobId, view.rows[0].id, { status: "removed" });
    await expect(finishImportReview(getDb(), shop, jobId)).rejects.toEqual(
      code("IMPORT_REVIEW_INCOMPLETE"),
    );
  });

  it("keeps every draft out of what buyers can search", async () => {
    const { shop, view, jobId } = await csvImport(readableCsv("Findable draft glass,9.90,EUR\n"));
    const search = () => searchProducts(getDb(), { query: "Findable draft glass" });
    expect((await search()).products).toEqual([]);
    await accept(shop, jobId, view.rows[0].id);
    await finishImportReview(getDb(), shop, jobId);
    expect((await search()).products).toEqual([]);
    expect(await getDb().select().from(products).where(eq(products.shopId, shop.id))).toEqual([]);
    // The check really can find a published product.
    await createProduct(getDb(), shop.id, { title: "Findable draft glass" });
    expect((await search()).products).toHaveLength(1);
  });

  it.each([
    ["a service with no duration", { kind: "service", priceMinor: 500, currency: "EUR", title: "A", depositMinor: 100 }, "import_rows_accepted_service_has_terms"],
    ["a service with no deposit", { kind: "service", priceMinor: 500, currency: "EUR", title: "A", serviceDurationMinutes: 30 }, "import_rows_accepted_service_has_terms"],
    ["a deposit above the price", { kind: "service", priceMinor: 500, currency: "EUR", title: "A", serviceDurationMinutes: 30, depositMinor: 600 }, "import_rows_accepted_service_has_terms"],
    ["a product with service terms", { kind: "product", priceMinor: 500, currency: "EUR", title: "A", serviceDurationMinutes: 30 }, "import_rows_accepted_product_has_no_service_terms"],
    ["no price", { kind: "product", currency: "EUR", title: "A" }, "import_rows_accepted_is_complete"],
    ["no currency", { kind: "product", priceMinor: 500, title: "A" }, "import_rows_accepted_is_complete"],
    ["no kind", { priceMinor: 500, currency: "EUR", title: "A" }, "import_rows_accepted_is_complete"],
    ["no name", { kind: "product", priceMinor: 500, currency: "EUR" }, "import_rows_accepted_is_complete"],
    ["a blank name", { kind: "product", priceMinor: 500, currency: "EUR", title: "  " }, "import_rows_accepted_is_complete"],
  ] as const)("has the database refuse an accepted row with %s", async (_name, values, constraint) => {
    const { shop, jobId } = await csvImport();
    expect(
      await violatedConstraint(
        getDb()
          .insert(importRows)
          .values({ jobId, shopId: shop.id, position: 99, sourceRef: "x", status: "accepted", ...values }),
      ),
    ).toBe(constraint);
  });

  it.each([
    ["a zero price", { priceMinor: 0 }, "import_rows_price_positive"],
    ["a negative price", { priceMinor: -5 }, "import_rows_price_positive"],
    ["a bad currency", { currency: "euro" }, "import_rows_currency_format"],
    ["a zero duration", { serviceDurationMinutes: 0 }, "import_rows_duration_positive"],
    ["a zero deposit", { depositMinor: 0 }, "import_rows_deposit_positive"],
    ["a negative position", { position: -1 }, "import_rows_position_not_negative"],
  ] as const)("has the database refuse a draft with %s", async (_name, values, constraint) => {
    const { shop, jobId } = await csvImport();
    expect(
      await violatedConstraint(
        getDb()
          .insert(importRows)
          .values({ jobId, shopId: shop.id, position: 99, sourceRef: "x", ...values }),
      ),
    ).toBe(constraint);
  });
});

describe("what blocks a row", () => {
  it("blocks a currency other than the shop's, without converting", async () => {
    const { shop, view, jobId } = await csvImport("name,price\nCable,5 USD\n");
    const [row] = view.rows;
    expect(row.issues).toEqual([
      expect.objectContaining({ code: "currency_mismatch", severity: "blocker" }),
    ]);
    await expect(
      updateImportRow(getDb(), shop, jobId, row.id, { status: "accepted" }),
    ).rejects.toEqual(code("IMPORT_ROW_BLOCKED"));

    const fixed = await updateImportRow(getDb(), shop, jobId, row.id, { price: "4.60 €" });
    expect(fixed.rows[0]).toMatchObject({ price: "4.60", currency: "EUR", issues: [] });
  });

  it("blocks an unknown currency until the seller states one", async () => {
    const { view } = await csvImport("name,price\nCable,5\n");
    expect(view.rows[0].currency).toBeNull();
    expect(view.rows[0].issues).toEqual([expect.objectContaining({ code: "currency_missing" })]);
  });

  it("blocks a missing name and an unknown kind", async () => {
    const { view } = await csvImport("name,price,currency,kind\n,5,EUR,gadget\n");
    expect(view.rows[0].issues.map((issue) => issue.code)).toEqual([
      "title_missing",
      "kind_missing",
    ]);
  });

  it("requires a service's duration and deposit, and keeps the deposit within the price", async () => {
    const { shop, view, jobId } = await csvImport("name,price,currency,kind\nRepair,80,EUR,service\n");
    const [row] = view.rows;
    expect(row.issues.map((issue) => issue.code)).toEqual(["duration_missing", "deposit_missing"]);

    const tooHigh = await updateImportRow(getDb(), shop, jobId, row.id, {
      serviceDurationMinutes: 45,
      deposit: "90",
    });
    expect(tooHigh.rows[0].issues.map((issue) => issue.code)).toEqual(["deposit_too_high"]);

    const fixed = await updateImportRow(getDb(), shop, jobId, row.id, {
      deposit: "20",
      status: "accepted",
    });
    expect(fixed.rows[0]).toMatchObject({ status: "accepted", deposit: "20.00", issues: [] });
  });
});

describe("editing a row", () => {
  it("stores corrected values and keeps what the source said", async () => {
    const { shop, view, jobId } = await csvImport("name,price\nCable,from 20\n");
    const updated = await updateImportRow(getDb(), shop, jobId, view.rows[0].id, {
      title: "  USB-C cable  ",
      description: "One metre",
      price: "20,00",
      currency: "EUR",
    });
    expect(updated.rows[0]).toMatchObject({
      title: "USB-C cable",
      description: "One metre",
      price: "20.00",
      priceText: "from 20",
      currency: "EUR",
      issues: [],
    });
  });

  it.each([
    ["from 20", /one amount/],
    ["1.200", /two ways/],
    ["0", /more than zero/],
    ["99999999999", /too large/],
  ])("refuses the price %j and changes nothing", async (price, message) => {
    const { shop, view, jobId } = await csvImport();
    await expect(
      updateImportRow(getDb(), shop, jobId, view.rows[0].id, { price, title: "Changed" }),
    ).rejects.toMatchObject({
      code: "IMPORT_ROW_INVALID",
      message: expect.stringMatching(message),
      details: { field: "price" },
    });
    expect((await rowsOf(getDb(), jobId))[0]).toMatchObject({ priceMinor: 990, title: "Tempered glass" });
  });

  it("refuses a bad deposit", async () => {
    const { shop, jobId, view } = await csvImport("name,price,currency,kind\nRepair,80,EUR,service\n");
    await expect(
      updateImportRow(getDb(), shop, jobId, view.rows[0].id, { deposit: "half" }),
    ).rejects.toMatchObject({ code: "IMPORT_ROW_INVALID", details: { field: "deposit" } });
  });

  it("lets a seller clear a price, which blocks the row again", async () => {
    const { shop, view, jobId } = await csvImport();
    const cleared = await updateImportRow(getDb(), shop, jobId, view.rows[0].id, { price: "" });
    expect(cleared.rows[0].price).toBeNull();
    expect(cleared.counts.blocked).toBe(1);
  });

  it.each([
    [{ shopId: "99999999-9999-4999-8999-999999999999" }],
    [{ jobId: "99999999-9999-4999-8999-999999999999" }],
    [{ priceMinor: 1 }],
    [{ sourceWarnings: [] }],
    [{ status: "published" }],
    [{ kind: "gadget" }],
    [{ currency: "eur" }],
    [{ serviceDurationMinutes: 0 }],
    [{ serviceDurationMinutes: 1.5 }],
    [{ title: "x".repeat(201) }],
    [null],
    ["text"],
  ])("refuses the patch %j", async (patch) => {
    const { shop, view, jobId } = await csvImport();
    await expect(
      updateImportRow(getDb(), shop, jobId, view.rows[0].id, patch),
    ).rejects.toEqual(code("INVALID_INPUT"));
  });

  it("clears service terms when a row becomes a product", async () => {
    const { shop, view, jobId } = await csvImport(
      "name,price,currency,kind,duration,deposit\nRepair,80,EUR,service,45,20\n",
    );
    const updated = await updateImportRow(getDb(), shop, jobId, view.rows[0].id, {
      kind: "product",
      status: "accepted",
    });
    expect(updated.rows[0]).toMatchObject({
      kind: "product",
      serviceDurationMinutes: null,
      deposit: null,
      status: "accepted",
    });
  });

  it("clears a doubt when the seller edits that field, and only then", async () => {
    const shop = await createShop(getDb());
    const { deps, model } = createImportHarness();
    const { id: jobId } = await createImport(getDb(), shop, { name: "a.jpg", bytes: JPEG }, deps);
    model.queue({ items: [extractedItem({ uncertain: ["name", "price"] })] });
    await runImportJob(getDb(), jobId, model.ai);

    const [before] = (await getImport(getDb(), shop, jobId)).rows;
    expect(before.issues.map((issue) => issue.code).sort()).toEqual(["uncertain_price", "uncertain_title"]);

    const afterTitle = await updateImportRow(getDb(), shop, jobId, before.id, { title: "Glass" });
    expect(afterTitle.rows[0].issues.map((issue) => issue.code)).toEqual(["uncertain_price"]);

    const afterPrice = await updateImportRow(getDb(), shop, jobId, before.id, { price: "9.90" });
    expect(afterPrice.rows[0].issues).toEqual([]);
  });

  it("allows accepting a row with a doubt, because that decision is the seller's", async () => {
    const shop = await createShop(getDb());
    const { deps, model } = createImportHarness();
    const { id: jobId } = await createImport(getDb(), shop, { name: "a.jpg", bytes: JPEG }, deps);
    model.queue({ items: [extractedItem({ uncertain: ["price"] })] });
    await runImportJob(getDb(), jobId, model.ai);
    const [row] = (await getImport(getDb(), shop, jobId)).rows;
    await expect(
      updateImportRow(getDb(), shop, jobId, row.id, { status: "accepted" }),
    ).resolves.toMatchObject({ counts: { accepted: 1 } });
  });

  it("sends an accepted row back when an edit breaks it", async () => {
    const { shop, view, jobId } = await csvImport();
    const id = view.rows[0].id;
    await updateImportRow(getDb(), shop, jobId, id, { status: "accepted" });

    const stillFine = await updateImportRow(getDb(), shop, jobId, id, { title: "Better name" });
    expect(stillFine.rows[0].status).toBe("accepted");

    const broken = await updateImportRow(getDb(), shop, jobId, id, { price: "" });
    expect(broken.rows[0].status).toBe("pending");
  });

  it("refuses an edit that keeps accepted status while breaking the row", async () => {
    const { shop, view, jobId } = await csvImport();
    await expect(
      updateImportRow(getDb(), shop, jobId, view.rows[0].id, { price: "", status: "accepted" }),
    ).rejects.toEqual(code("IMPORT_ROW_BLOCKED"));
  });

  it("lets a removed row be restored", async () => {
    const { shop, view, jobId } = await csvImport();
    const id = view.rows[0].id;
    const removed = await updateImportRow(getDb(), shop, jobId, id, { status: "removed" });
    expect(removed.counts).toMatchObject({ removed: 1, pending: 1 });
    const restored = await updateImportRow(getDb(), shop, jobId, id, { status: "pending" });
    expect(restored.counts).toMatchObject({ removed: 0, pending: 2 });
  });

  it("flags rows with the same name, ignoring removed ones", async () => {
    const { shop, view, jobId } = await csvImport(
      "name,price,currency\nCable,5,EUR\n cable ,6,EUR\nCharger,7,EUR\n",
    );
    const duplicate = (rows: typeof view.rows) =>
      rows.map((row) => row.issues.some((issue) => issue.code === "duplicate_title"));
    expect(duplicate(view.rows)).toEqual([true, true, false]);

    const removed = await updateImportRow(getDb(), shop, jobId, view.rows[1].id, { status: "removed" });
    expect(duplicate(removed.rows)).toEqual([false, false, false]);
  });

  it("refuses edits once the import has moved on", async () => {
    const { shop, view, jobId } = await csvImport("name,price,currency\nCable,5,EUR\n");
    const id = view.rows[0].id;
    await updateImportRow(getDb(), shop, jobId, id, { status: "accepted" });
    await finishImportReview(getDb(), shop, jobId);
    const notEditable = code("IMPORT_NOT_EDITABLE");
    await expect(updateImportRow(getDb(), shop, jobId, id, { title: "x" })).rejects.toEqual(notEditable);
    await expect(
      applyBulkAction(getDb(), shop, jobId, { action: "accept_clean" }),
    ).rejects.toEqual(notEditable);
    await expect(finishImportReview(getDb(), shop, jobId)).rejects.toEqual(notEditable);
  });

  it("refuses edits and finishing while a photo is still being read", async () => {
    const { shop, jobId } = await photoImport();
    await expect(finishImportReview(getDb(), shop, jobId)).rejects.toEqual(code("IMPORT_NOT_EDITABLE"));
    await expect(
      applyBulkAction(getDb(), shop, jobId, { action: "set_missing_currency" }),
    ).rejects.toEqual(code("IMPORT_NOT_EDITABLE"));
  });
});

describe("bulk actions", () => {
  it("fills in the currency only where the source said nothing", async () => {
    const { shop, jobId } = await csvImport("name,price\nCable,5\nCharger,6 USD\nCase,7 EUR\n");
    const view = await applyBulkAction(getDb(), shop, jobId, { action: "set_missing_currency" });
    expect(view.rows.map((row) => row.currency)).toEqual(["EUR", "USD", "EUR"]);
  });

  it("does not touch a removed row", async () => {
    const { shop, view, jobId } = await csvImport("name,price\nCable,5\nCharger,6\n");
    await updateImportRow(getDb(), shop, jobId, view.rows[0].id, { status: "removed" });
    const updated = await applyBulkAction(getDb(), shop, jobId, { action: "set_missing_currency" });
    expect(updated.rows.map((row) => row.currency)).toEqual([null, "EUR"]);
  });

  it("accepts only rows with no blocker and no doubt", async () => {
    const { shop, jobId } = await csvImport(
      "name,price,currency,duration\nClean,5,EUR,\nNo price,,EUR,\nDuplicate,5,EUR,\nDuplicate,5,EUR,\nDoubtful,5,EUR,soon\n",
    );
    const view = await applyBulkAction(getDb(), shop, jobId, { action: "accept_clean" });
    expect(view.rows.map((row) => [row.title, row.status])).toEqual([
      ["Clean", "accepted"],
      ["No price", "pending"],
      ["Duplicate", "pending"],
      ["Duplicate", "pending"],
      ["Doubtful", "pending"],
    ]);
  });

  it("leaves a removed row removed", async () => {
    const { shop, view, jobId } = await csvImport();
    await updateImportRow(getDb(), shop, jobId, view.rows[0].id, { status: "removed" });
    const updated = await applyBulkAction(getDb(), shop, jobId, { action: "accept_clean" });
    expect(updated.rows.map((row) => row.status)).toEqual(["removed", "accepted"]);
  });

  it("refuses an unknown action", async () => {
    const { shop, jobId } = await csvImport();
    await expect(
      applyBulkAction(getDb(), shop, jobId, { action: "publish_everything" }),
    ).rejects.toEqual(code("INVALID_INPUT"));
  });
});

describe("retention of the source photo", () => {
  it("deletes the photo when the review finishes", async () => {
    const { shop, jobId, model } = await photoImport();
    model.queue({ items: [extractedItem({ currency: "EUR" })] });
    await runImportJob(getDb(), jobId, model.ai);
    const [row] = (await getImport(getDb(), shop, jobId)).rows;
    await updateImportRow(getDb(), shop, jobId, row.id, { status: "accepted" });

    await finishImportReview(getDb(), shop, jobId);

    expect(await sourceOf(getDb(), jobId)).toBeUndefined();
    expect((await getImport(getDb(), shop, jobId)).hasSource).toBe(false);
    await expect(readImportSource(getDb(), shop, jobId)).rejects.toEqual(code("IMPORT_NOT_FOUND"));
  });

  it("does not delete the photo when finishing is refused", async () => {
    const { shop, jobId, model } = await photoImport();
    model.queue({ items: [extractedItem()] });
    await runImportJob(getDb(), jobId, model.ai);
    await expect(finishImportReview(getDb(), shop, jobId)).rejects.toBeDefined();
    expect(await sourceOf(getDb(), jobId)).toBeDefined();
  });

  it("shows the photo to its seller, with its stored type", async () => {
    const { shop, jobId } = await photoImport();
    const source = await readImportSource(getDb(), shop, jobId);
    expect(source.mediaType).toBe("image/jpeg");
    expect(source.bytes.equals(JPEG)).toBe(true);
  });
});

describe("one shop cannot reach another's import", () => {
  async function foreign() {
    const owner = await csvImport();
    const stranger = await createShop(getDb());
    return { ...owner, stranger };
  }

  const notFound = code("IMPORT_NOT_FOUND");

  it("gives the same answer as an import that does not exist", async () => {
    const { stranger, jobId, deps, view } = await foreign();
    const db = getDb();
    await expect(getImport(db, stranger, jobId)).rejects.toEqual(notFound);
    await expect(
      updateImportRow(db, stranger, jobId, view.rows[0].id, { title: "Mine now" }),
    ).rejects.toEqual(notFound);
    await expect(
      applyBulkAction(db, stranger, jobId, { action: "accept_clean" }),
    ).rejects.toEqual(notFound);
    await expect(finishImportReview(db, stranger, jobId)).rejects.toEqual(notFound);
    await expect(retryImport(db, stranger, jobId, deps)).rejects.toEqual(notFound);
    await expect(readImportSource(db, stranger, jobId)).rejects.toEqual(notFound);
    await expect(suggestDescriptions(db, stranger, jobId, deps)).rejects.toEqual(notFound);
    expect((await rowsOf(db, jobId))[0].title).toBe("Tempered glass");
  });

  it("does not serve another shop's photo", async () => {
    const { jobId } = await photoImport();
    const stranger = await createShop(getDb());
    await expect(readImportSource(getDb(), stranger, jobId)).rejects.toEqual(notFound);
  });

  it("does not list another shop's imports", async () => {
    const { jobId, shop } = await foreign();
    const other = await csvImport();
    expect((await listImports(getDb(), shop)).map((entry) => entry.id)).toEqual([jobId]);
    expect((await listImports(getDb(), other.shop)).map((entry) => entry.id)).toEqual([other.jobId]);
  });

  it("cannot edit a row through another import of the same shop", async () => {
    const first = await csvImport();
    const harness = createImportHarness();
    const second = await createImport(
      getDb(),
      first.shop,
      { name: "b.csv", bytes: readableCsv() },
      harness.deps,
    );
    await expect(
      updateImportRow(getDb(), first.shop, second.id, first.view.rows[0].id, { title: "x" }),
    ).rejects.toEqual(code("IMPORT_ROW_NOT_FOUND"));
  });

  it.each(["not-a-uuid", "", null, 7, "99999999-9999-4999-8999-999999999999"])(
    "treats the identifier %j as not found",
    async (id) => {
      const { shop, jobId } = await csvImport();
      await expect(getImport(getDb(), shop, id)).rejects.toEqual(notFound);
      await expect(
        updateImportRow(getDb(), shop, id, id, { title: "x" }),
      ).rejects.toEqual(notFound);
      await expect(
        updateImportRow(getDb(), shop, jobId, id, { title: "x" }),
      ).rejects.toEqual(code("IMPORT_ROW_NOT_FOUND"));
    },
  );

  it("returns no internal fields to a seller", async () => {
    const { view, shop, jobId } = await csvImport();
    expect(Object.keys(view).sort()).toEqual(
      [
        "counts",
        "createdAt",
        "error",
        "hasSource",
        "id",
        "ignoredColumns",
        "model",
        "promptVersion",
        "publishedCount",
        "rows",
        "shopCurrency",
        "sourceKind",
        "sourceName",
        "status",
      ].sort(),
    );
    expect(Object.keys(view.rows[0])).not.toContain("shopId");
    expect(Object.keys((await listImports(getDb(), shop))[0]).sort()).toEqual(
      ["createdAt", "id", "publishedCount", "rowCount", "sourceKind", "sourceName", "status"].sort(),
    );
    expect(jobId).toBe(view.id);
  });
});

describe("a deposit in another currency", () => {
  const serviceCsv = "name,price,currency,kind,duration,deposit\nScreen repair,80.00,EUR,service,60,20.00\n";

  it("is refused in the review table, as in the catalog", async () => {
    const { shop, view, jobId } = await csvImport(serviceCsv);
    const rowId = view.rows[0].id;
    await expect(
      updateImportRow(getDb(), shop, jobId, rowId, { deposit: "30 USD", status: "accepted" }),
    ).rejects.toEqual(expect.objectContaining({ code: "IMPORT_ROW_INVALID", details: { field: "deposit" } }));
    expect((await rowsOf(getDb(), jobId))[0].depositMinor).toBe(2000);
  });

  it("is kept when it states the shop's currency", async () => {
    const { shop, view, jobId } = await csvImport(serviceCsv);
    const after = await updateImportRow(getDb(), shop, jobId, view.rows[0].id, { deposit: "30 EUR" });
    expect(after.rows[0].deposit).toBe("30.00");
  });

  it("stops an upload's row from being accepted until the seller enters one", async () => {
    const { shop, view, jobId } = await csvImport(
      "name,price,currency,kind,duration,deposit\nScreen repair,80.00,EUR,service,60,$20.00\n",
    );
    const after = await applyBulkAction(getDb(), shop, jobId, { action: "accept_clean" });
    expect(after.rows[0]).toMatchObject({ status: "pending", deposit: null });
    expect(after.rows[0].issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["deposit_missing", "deposit_currency"]),
    );

    const fixed = await updateImportRow(getDb(), shop, jobId, view.rows[0].id, { deposit: "20.00" });
    expect(fixed.rows[0].issues).toEqual([]);
  });
});

describe("listing imports", () => {
  it("shows the newest first, counting rows that were not removed", async () => {
    const { shop, view, jobId, deps } = await csvImport();
    await updateImportRow(getDb(), shop, jobId, view.rows[0].id, { status: "removed" });
    await getDb()
      .update(importJobs)
      .set({ createdAt: sql`now() - interval '1 hour'` })
      .where(eq(importJobs.id, jobId));
    const newer = await createImport(getDb(), shop, { name: "b.jpg", bytes: JPEG }, deps);

    expect(await listImports(getDb(), shop)).toMatchObject([
      { id: newer.id, sourceKind: "photo", sourceName: "b.jpg", status: "queued", rowCount: 0 },
      { id: jobId, sourceKind: "csv", sourceName: "prices.csv", status: "needs_review", rowCount: 1 },
    ]);
  });
});

describe("suggesting descriptions", () => {
  it("fills in editable suggestions and records the model", async () => {
    const { shop, jobId, model, deps } = await csvImport();
    const { view, remaining } = await suggestDescriptions(getDb(), shop, jobId, deps);
    expect(remaining).toBe(0);
    expect(view.rows[0]).toMatchObject({
      descriptionEn: "English for Tempered glass.",
      descriptionLv: "Latviski Tempered glass.",
      status: "pending",
    });
    expect(model.suggestionRequests[0][0]).toEqual({
      position: 0,
      title: "Tempered glass",
      kind: "product",
      description: null,
    });
    expect((await jobRow(getDb(), jobId)).result).toMatchObject({
      rowCount: 2,
      suggestions: { model: "fake-model", promptVersion: "fake-descriptions-v1" },
    });

    const edited = await updateImportRow(getDb(), shop, jobId, view.rows[0].id, {
      descriptionEn: "My own words.",
      descriptionLv: "",
    });
    expect(edited.rows[0]).toMatchObject({ descriptionEn: "My own words.", descriptionLv: null });
  });

  it("does not change a price, a name or the source's description", async () => {
    const { shop, jobId, deps } = await csvImport(
      "name,price,currency,description\nGlass,9.90,EUR,As printed\n",
    );
    const { view } = await suggestDescriptions(getDb(), shop, jobId, deps);
    expect(view.rows[0]).toMatchObject({ title: "Glass", price: "9.90", description: "As printed" });
  });

  it("works in batches and reports what is left", async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `Item ${index},5,EUR`).join("\n");
    const { shop, jobId, model, deps } = await csvImport(`name,price,currency\n${lines}\n`);
    model.setSuggestion((rows) =>
      rows.map((row) => ({ position: row.position, english: "An item.", latvian: "Prece." })),
    );
    await expect(suggestDescriptions(getDb(), shop, jobId, deps)).resolves.toMatchObject({ remaining: 5 });
    await expect(suggestDescriptions(getDb(), shop, jobId, deps)).resolves.toMatchObject({ remaining: 0 });
    expect(model.suggestionRequests.map((batch) => batch.length)).toEqual([25, 5]);

    await suggestDescriptions(getDb(), shop, jobId, deps);
    expect(model.suggestionRequests).toHaveLength(2);
  });

  it("does not spend anything on a row that is removed or has no name", async () => {
    const { shop, jobId, view, model, deps } = await csvImport(
      "name,price,currency\nCable,5,EUR\nCharger,6,EUR\n,7,EUR\n",
    );
    await updateImportRow(getDb(), shop, jobId, view.rows[0].id, { status: "removed" });
    await suggestDescriptions(getDb(), shop, jobId, deps);
    expect(model.suggestionRequests[0].map((row) => row.title)).toEqual(["Charger"]);
  });

  it("does not overwrite what a seller wrote while the model was answering", async () => {
    const { shop, jobId, view, model, deps } = await csvImport("name,price,currency\nCable,5,EUR\n");
    model.setSuggestion((rows) => {
      return rows.map((row) => ({ position: row.position, english: "Suggested.", latvian: "Ieteikts." }));
    });
    const suggestion = model.ai.suggestDescriptions.bind(model.ai);
    model.ai.suggestDescriptions = async (rows) => {
      await updateImportRow(getDb(), shop, jobId, view.rows[0].id, { descriptionEn: "My words." });
      return suggestion(rows);
    };
    const { view: after } = await suggestDescriptions(getDb(), shop, jobId, deps);
    expect(after.rows[0]).toMatchObject({ descriptionEn: "My words.", descriptionLv: null });
  });

  it.each([
    ["an invented specification", { english: "A 5000 mAh battery.", latvian: "Baterija." }],
    ["a specification only in Latvian", { english: "A battery.", latvian: "5000 mAh baterija." }],
    ["an empty suggestion", { english: "  ", latvian: "Baterija." }],
  ])("drops %s, flags the row and does not ask again", async (_name, words) => {
    const { shop, jobId, model, deps } = await csvImport("name,price,currency\nBattery,5,EUR\n");
    model.setSuggestion((rows) => rows.map((row) => ({ position: row.position, ...words })));
    const { view, remaining } = await suggestDescriptions(getDb(), shop, jobId, deps);
    expect(remaining).toBe(0);
    expect(view.rows[0]).toMatchObject({ descriptionEn: null, descriptionLv: null });
    expect(view.rows[0].issues).toEqual([
      expect.objectContaining({ code: "suggestion_rejected", severity: "warning" }),
    ]);
    await suggestDescriptions(getDb(), shop, jobId, deps);
    expect(model.suggestionRequests).toHaveLength(1);
  });

  it("allows numbers the row already states", async () => {
    const { shop, jobId, model, deps } = await csvImport(
      "name,price,currency,description\nGlass for iPhone 13,5,EUR,9H\n",
    );
    model.setSuggestion((rows) =>
      rows.map((row) => ({
        position: row.position,
        english: "9H glass for iPhone 13.",
        latvian: "9H stikls iPhone 13.",
      })),
    );
    const { view } = await suggestDescriptions(getDb(), shop, jobId, deps);
    expect(view.rows[0].descriptionEn).toBe("9H glass for iPhone 13.");
  });

  it("ignores an answer for a row it did not ask about", async () => {
    const { shop, jobId, model, deps } = await csvImport("name,price,currency\nCable,5,EUR\n");
    model.setSuggestion(() => [{ position: 99, english: "Other.", latvian: "Cits." }]);
    const { view } = await suggestDescriptions(getDb(), shop, jobId, deps);
    expect(view.rows[0].descriptionEn).toBeNull();
    expect(view.rows[0].issues[0].code).toBe("suggestion_rejected");
  });

  it("reports a provider failure and leaves the rows as they were", async () => {
    const { shop, jobId, model, deps } = await csvImport();
    model.setSuggestion(new AiFailure("PROVIDER_UNAVAILABLE"));
    await expect(suggestDescriptions(getDb(), shop, jobId, deps)).rejects.toEqual(
      code("SUGGESTIONS_UNAVAILABLE"),
    );
    expect((await rowsOf(getDb(), jobId)).every((row) => row.descriptionEn === null)).toBe(true);
  });

  it("is refused with a clear message when no model is configured", async () => {
    const { shop, jobId } = await csvImport();
    await expect(
      suggestDescriptions(getDb(), shop, jobId, { ai: undefined }),
    ).rejects.toEqual(code("IMPORT_NOT_CONFIGURED"));
  });

  it("is refused once the review has finished", async () => {
    const { shop, view, jobId, deps } = await csvImport("name,price,currency\nCable,5,EUR\n");
    await updateImportRow(getDb(), shop, jobId, view.rows[0].id, { status: "accepted" });
    await finishImportReview(getDb(), shop, jobId);
    await expect(suggestDescriptions(getDb(), shop, jobId, deps)).rejects.toEqual(
      code("IMPORT_NOT_EDITABLE"),
    );
  });
});
