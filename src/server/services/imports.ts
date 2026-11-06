import "server-only";

import { and, asc, count, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { AiFailure } from "../ai/types";
import { importBulkAction, importId, importRowPatch } from "../contracts/imports";
import type {
  ImportRowView,
  ImportStatus,
  ImportSummaryView,
  ImportView,
} from "../contracts/imports";
import type { Db } from "../db/client";
import { importJobs, importRows, importSources, products, shops } from "../db/schema";
import { ServiceError, parseInput } from "../errors";
import { parsePriceListCsv } from "../imports/csv";
import {
  DUPLICATE_WARNING,
  MAX_DESCRIPTION_LENGTH,
  cleanSourceText,
  hasBlocker,
  minorToText,
  rowIssues,
  titleKey,
  warningsClearedBy,
  type RowField,
  type RowIssue,
} from "../imports/draft-rows";
import { suggestionKeepsToFacts } from "../imports/extraction";
import { detectFileType, displayFileName } from "../imports/file-type";
import { parsePriceText, priceProblemMessage } from "../imports/price-text";
import type { ImportDeps } from "./import-start";
import type { ImportRunCode } from "./import-run";
import type { Tx } from "./payment-reconciliation";

// Seller review of an import: uploading a file, correcting rows, and deciding what goes forward.
// Every function takes the shop from the seller's session and scopes every query to it. A job or
// row in another shop gets the same answer as one that does not exist.

// The API allows 10 MB of base64 per image, which is 7.5 MB of bytes. The browser shrinks a phone
// photo long before this, so the limit is only reached by a client that skips that step.
export const MAX_IMAGE_BYTES = 7_000_000;
export const MAX_UPLOAD_BODY_BYTES = MAX_IMAGE_BYTES + 64 * 1024;

// A photo costs a paid model call, and a seller code is shared with a demo's judges. A retry reads the
// photo again, so these hold for a retry as for an upload.
const MAX_ACTIVE_PHOTO_IMPORTS = 3;
const MAX_PHOTO_IMPORTS_PER_DAY = 30;

export const SOURCE_RETENTION = sql`interval '72 hours'`;
const SUGGESTION_BATCH = 25;
const LIST_LIMIT = 20;

export type SellerShop = { id: string; currency: string };

const RUN_ERRORS: Record<ImportRunCode, { message: string; retryable: boolean }> = {
  NOTHING_FOUND: {
    message:
      "We could not find anything for sale in this photo. Try a sharper photo, closer to the list.",
    retryable: true,
  },
  SOURCE_REJECTED: {
    message: "The AI service could not read this image. Try another photo, or upload a CSV.",
    retryable: false,
  },
  MALFORMED_OUTPUT: {
    message: "The AI service returned something unusable, so nothing was saved. Try again.",
    retryable: true,
  },
  PROVIDER_UNAVAILABLE: {
    message: "The AI service did not answer, so nothing was saved. Try again in a few minutes.",
    retryable: true,
  },
  PROVIDER_REJECTED: {
    message: "Photo reading is unavailable right now, so nothing was saved. You can upload a CSV instead.",
    retryable: true,
  },
  REFUSED: {
    message: "The AI service declined to read this image. Try another photo, or upload a CSV.",
    retryable: true,
  },
  TOO_LONG: {
    message: "This list is too long to read from one photo. Photograph it in parts, or upload a CSV.",
    retryable: false,
  },
  NOT_CONFIGURED: {
    message: "Photo reading is not set up on this server. You can upload a CSV instead.",
    retryable: true,
  },
  SOURCE_EXPIRED: {
    message: "This photo is no longer stored. Upload it again.",
    retryable: false,
  },
  RUN_ABANDONED: {
    message: "Reading this photo stopped before it finished, so nothing was saved. Try again.",
    retryable: true,
  },
  RUN_NOT_STARTED: {
    message: "Reading this photo did not start, so nothing was saved. Try again.",
    retryable: true,
  },
  INTERNAL: {
    message: "Something went wrong, so nothing was saved. Try again.",
    retryable: true,
  },
};

type RowRecord = typeof importRows.$inferSelect;

function toRowView(
  row: RowRecord,
  shopCurrency: string,
  duplicateTitles: ReadonlySet<string>,
): ImportRowView {
  const issues: RowIssue[] = rowIssues(row, shopCurrency);
  const key = titleKey(row.title);
  if (row.status !== "removed" && key && duplicateTitles.has(key)) {
    issues.push(DUPLICATE_WARNING);
  }
  return {
    id: row.id,
    position: row.position,
    sourceRef: row.sourceRef,
    status: row.status,
    title: row.title,
    kind: row.kind,
    price: minorToText(row.priceMinor),
    priceText: row.priceText,
    currency: row.currency,
    serviceDurationMinutes: row.serviceDurationMinutes,
    deposit: minorToText(row.depositMinor),
    description: row.description,
    descriptionEn: row.descriptionEn,
    descriptionLv: row.descriptionLv,
    issues,
  };
}

function findDuplicateTitles(rows: readonly RowRecord[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const key = titleKey(row.title);
    if (key && row.status !== "removed") {
      (seen.has(key) ? duplicates : seen).add(key);
    }
  }
  return duplicates;
}

function jobError(
  status: ImportStatus,
  code: string | null,
  hasSource: boolean,
): ImportView["error"] {
  // A queued job can carry the last attempt's code while it waits to run again.
  if (status !== "failed" || !code) {
    return null;
  }
  const known = RUN_ERRORS[code as ImportRunCode] ?? RUN_ERRORS.INTERNAL;
  return { code, message: known.message, retryable: known.retryable && hasSource };
}

async function findJob(db: Db, shop: SellerShop, rawId: unknown) {
  const id = importId.safeParse(rawId);
  const [job] = id.success
    ? await db
        .select()
        .from(importJobs)
        .where(and(eq(importJobs.id, id.data), eq(importJobs.shopId, shop.id)))
    : [];
  if (!job) {
    throw new ServiceError("IMPORT_NOT_FOUND", "This import does not exist.");
  }
  return job;
}

async function buildView(
  db: Db,
  shop: SellerShop,
  job: typeof importJobs.$inferSelect,
): Promise<ImportView> {
  const [rows, sources, [published]] = await Promise.all([
    db
      .select()
      .from(importRows)
      .where(and(eq(importRows.jobId, job.id), eq(importRows.shopId, shop.id)))
      .orderBy(asc(importRows.position)),
    db
      .select({ jobId: importSources.jobId })
      .from(importSources)
      .where(and(eq(importSources.jobId, job.id), eq(importSources.shopId, shop.id))),
    db
      .select({ value: count() })
      .from(products)
      .where(and(eq(products.importJobId, job.id), eq(products.shopId, shop.id))),
  ]);
  const hasSource = sources.length > 0;
  const duplicates = findDuplicateTitles(rows);
  const views = rows.map((row) => toRowView(row, shop.currency, duplicates));
  const live = views.filter((row) => row.status !== "removed");
  const result = job.result as { ignoredColumns?: string[] } | null;
  return {
    id: job.id,
    sourceKind: job.sourceKind,
    sourceName: job.sourceRef ?? "Untitled",
    status: job.status,
    createdAt: job.createdAt.toISOString(),
    shopCurrency: shop.currency,
    error: jobError(job.status, job.error, hasSource),
    hasSource,
    model: job.model,
    promptVersion: job.promptVersion,
    ignoredColumns: result?.ignoredColumns ?? [],
    rows: views,
    publishedCount: published.value,
    counts: {
      total: views.length,
      blocked: live.filter((row) => hasBlocker(row.issues)).length,
      pending: live.filter((row) => row.status === "pending").length,
      accepted: live.filter((row) => row.status === "accepted").length,
      removed: views.length - live.length,
    },
  };
}

export async function getImport(db: Db, shop: SellerShop, rawId: unknown): Promise<ImportView> {
  return buildView(db, shop, await findJob(db, shop, rawId));
}

export async function listImports(db: Db, shop: SellerShop): Promise<ImportSummaryView[]> {
  const jobs = await db
    .select({
      id: importJobs.id,
      sourceKind: importJobs.sourceKind,
      sourceRef: importJobs.sourceRef,
      status: importJobs.status,
      createdAt: importJobs.createdAt,
      rowCount: sql<number>`count(${importRows.id}) FILTER (WHERE ${importRows.status} <> 'removed')::int`,
      publishedCount: sql<number>`(SELECT count(*) FROM ${products} WHERE ${products.importJobId} = ${importJobs.id})::int`,
    })
    .from(importJobs)
    .leftJoin(importRows, eq(importRows.jobId, importJobs.id))
    .where(eq(importJobs.shopId, shop.id))
    .groupBy(importJobs.id)
    .orderBy(desc(importJobs.createdAt))
    .limit(LIST_LIMIT);
  return jobs.map((job) => ({
    id: job.id,
    sourceKind: job.sourceKind,
    sourceName: job.sourceRef ?? "Untitled",
    status: job.status,
    createdAt: job.createdAt.toISOString(),
    rowCount: job.rowCount,
    publishedCount: job.publishedCount,
  }));
}

// Takes the shop's row for the rest of the transaction, so requests arriving together are counted one
// after another, and the transaction that passes has to add its own read before it ends. A retry is
// counted by when its job last changed, which can only make the day's count higher than it was.
async function assertUnderPhotoLimits(tx: Tx, shop: SellerShop): Promise<void> {
  await tx.select({ id: shops.id }).from(shops).where(eq(shops.id, shop.id)).for("no key update");
  const [usage] = await tx
    .select({
      active: sql<number>`count(*) FILTER (WHERE ${importJobs.status} IN ('queued', 'running'))::int`,
      today: sql<number>`(
        count(*) FILTER (WHERE ${importJobs.createdAt} > now() - interval '24 hours')
        + coalesce(sum(${importJobs.retries}) FILTER (WHERE ${importJobs.updatedAt} > now() - interval '24 hours'), 0)
      )::int`,
    })
    .from(importJobs)
    .where(and(eq(importJobs.shopId, shop.id), eq(importJobs.sourceKind, "photo")));
  if (usage.active >= MAX_ACTIVE_PHOTO_IMPORTS) {
    throw new ServiceError(
      "IMPORT_LIMIT_REACHED",
      "Several photos are still being read. Wait for them to finish.",
    );
  }
  if (usage.today >= MAX_PHOTO_IMPORTS_PER_DAY) {
    throw new ServiceError(
      "IMPORT_LIMIT_REACHED",
      "This shop has read as many photos as it can today. Try again tomorrow, or upload a CSV.",
    );
  }
}

async function createCsvImport(
  db: Db,
  shop: SellerShop,
  name: string,
  bytes: Buffer,
): Promise<ImportView> {
  const parsed = parsePriceListCsv(bytes);
  if (!parsed.ok) {
    throw new ServiceError("IMPORT_FILE_INVALID", parsed.message);
  }
  const job = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(importJobs)
      .values({
        shopId: shop.id,
        sourceKind: "csv",
        status: "needs_review",
        sourceRef: name,
        result: { rowCount: parsed.rows.length, ignoredColumns: parsed.ignoredColumns },
      })
      .returning();
    await tx
      .insert(importRows)
      .values(parsed.rows.map((row) => ({ ...row, jobId: created.id, shopId: shop.id })));
    return created;
  });
  return buildView(db, shop, job);
}

// A failure to start is not a failure of the upload. The photo is stored, and the sweep tries again.
async function startRun(db: Db, deps: ImportDeps, job: { id: string; updatedAt: Date }) {
  try {
    await deps.startRun(db, job);
  } catch (error) {
    console.error("Could not start an import run", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

export async function createImport(
  db: Db,
  shop: SellerShop,
  file: { name: string; bytes: Buffer },
  deps: ImportDeps,
): Promise<ImportView> {
  const name = displayFileName(file.name);
  const type = detectFileType(file.name, file.bytes);
  if (type.kind === "unsupported") {
    throw new ServiceError("IMPORT_FILE_UNSUPPORTED", type.message);
  }
  if (type.kind === "csv") {
    return createCsvImport(db, shop, name, file.bytes);
  }

  if (file.bytes.length > MAX_IMAGE_BYTES) {
    throw new ServiceError(
      "IMPORT_FILE_TOO_LARGE",
      `This photo is larger than ${MAX_IMAGE_BYTES / 1_000_000} MB. Try a smaller one.`,
    );
  }
  if (!deps.ai) {
    throw new ServiceError(
      "IMPORT_NOT_CONFIGURED",
      "Photo reading is not set up on this server. You can upload a CSV instead.",
    );
  }

  const job = await db.transaction(async (tx) => {
    await assertUnderPhotoLimits(tx, shop);
    const [created] = await tx
      .insert(importJobs)
      .values({ shopId: shop.id, sourceKind: "photo", status: "queued", sourceRef: name })
      .returning();
    await tx.insert(importSources).values({
      jobId: created.id,
      shopId: shop.id,
      mediaType: type.mediaType,
      bytes: file.bytes,
      expiresAt: sql`now() + ${SOURCE_RETENTION}`,
    });
    return created;
  });
  await startRun(db, deps, job);
  return getImport(db, shop, job.id);
}

// Runs a change while holding the job, so a row cannot change under a seller finishing the review.
async function withEditableJob<T>(
  db: Db,
  shop: SellerShop,
  rawId: unknown,
  change: (tx: Tx, job: typeof importJobs.$inferSelect) => Promise<T>,
): Promise<T> {
  const id = importId.safeParse(rawId);
  return db.transaction(async (tx) => {
    const [job] = id.success
      ? await tx
          .select()
          .from(importJobs)
          .where(and(eq(importJobs.id, id.data), eq(importJobs.shopId, shop.id)))
          .for("update")
      : [];
    if (!job) {
      throw new ServiceError("IMPORT_NOT_FOUND", "This import does not exist.");
    }
    if (job.status !== "needs_review") {
      throw new ServiceError("IMPORT_NOT_EDITABLE", "This import cannot be changed now.");
    }
    return change(tx, job);
  });
}

function parseEditedAmount(text: string | null, field: "price" | "deposit") {
  const parsed = parsePriceText(text);
  if (parsed.problem === "missing") {
    return { minor: null, currency: null };
  }
  if (parsed.problem) {
    throw new ServiceError("IMPORT_ROW_INVALID", priceProblemMessage(parsed.problem), { field });
  }
  return parsed;
}

const blank = (text: string | null) => (text === "" ? null : text);

export async function updateImportRow(
  db: Db,
  shop: SellerShop,
  rawJobId: unknown,
  rawRowId: unknown,
  rawPatch: unknown,
): Promise<ImportView> {
  const patch = parseInput(importRowPatch, rawPatch);
  const rowId = importId.safeParse(rawRowId);

  await withEditableJob(db, shop, rawJobId, async (tx, job) => {
    const [row] = rowId.success
      ? await tx
          .select()
          .from(importRows)
          .where(
            and(
              eq(importRows.id, rowId.data),
              eq(importRows.jobId, job.id),
              eq(importRows.shopId, shop.id),
            ),
          )
      : [];
    if (!row) {
      throw new ServiceError("IMPORT_ROW_NOT_FOUND", "This row does not exist.");
    }

    const next = { ...row };
    const edited = new Set<RowField>();
    if (patch.title !== undefined) {
      next.title = blank(patch.title);
      edited.add("title");
    }
    if (patch.description !== undefined) {
      next.description = blank(patch.description);
      edited.add("description");
    }
    if (patch.descriptionEn !== undefined) {
      next.descriptionEn = blank(patch.descriptionEn);
    }
    if (patch.descriptionLv !== undefined) {
      next.descriptionLv = blank(patch.descriptionLv);
    }
    if (patch.kind !== undefined) {
      next.kind = patch.kind;
      edited.add("kind");
    }
    if (patch.currency !== undefined) {
      next.currency = patch.currency;
      edited.add("currency");
    }
    if (patch.price !== undefined) {
      const price = parseEditedAmount(patch.price, "price");
      next.priceMinor = price.minor;
      // A seller who writes "12 €" has also said which currency they mean.
      next.currency = patch.currency !== undefined ? next.currency : (price.currency ?? next.currency);
      edited.add("price");
    }
    if (patch.serviceDurationMinutes !== undefined) {
      next.serviceDurationMinutes = patch.serviceDurationMinutes;
      edited.add("duration");
    }
    if (patch.deposit !== undefined) {
      const deposit = parseEditedAmount(patch.deposit, "deposit");
      // Stored as a bare number and charged in the shop's currency, so another currency is refused.
      if (deposit.currency && deposit.currency !== shop.currency) {
        throw new ServiceError(
          "IMPORT_ROW_INVALID",
          `This shop sells in ${shop.currency}. Enter the deposit in ${shop.currency}.`,
          { field: "deposit" },
        );
      }
      next.depositMinor = deposit.minor;
      edited.add("deposit");
    }
    if (next.kind === "product") {
      next.serviceDurationMinutes = null;
      next.depositMinor = null;
    }

    const cleared = [...edited].flatMap(warningsClearedBy);
    next.sourceWarnings = row.sourceWarnings.filter((code) => !cleared.includes(code));

    const blockers = rowIssues(next, shop.currency).filter((issue) => issue.severity === "blocker");
    if (patch.status === "accepted" && blockers.length > 0) {
      throw new ServiceError(
        "IMPORT_ROW_BLOCKED",
        `Fix this row first: ${blockers.map((issue) => issue.message).join(" ")}`,
        { issues: blockers.map(({ code, field }) => ({ code, field })) },
      );
    }
    // An edit that breaks an accepted row sends it back to be looked at.
    next.status = patch.status ?? (row.status === "accepted" && blockers.length > 0 ? "pending" : row.status);

    await tx
      .update(importRows)
      .set({
        title: next.title,
        description: next.description,
        descriptionEn: next.descriptionEn,
        descriptionLv: next.descriptionLv,
        kind: next.kind,
        priceMinor: next.priceMinor,
        currency: next.currency,
        serviceDurationMinutes: next.serviceDurationMinutes,
        depositMinor: next.depositMinor,
        sourceWarnings: next.sourceWarnings,
        status: next.status,
      })
      .where(eq(importRows.id, row.id));
  });
  return getImport(db, shop, rawJobId);
}

export async function applyBulkAction(
  db: Db,
  shop: SellerShop,
  rawJobId: unknown,
  rawAction: unknown,
): Promise<ImportView> {
  const { action } = parseInput(importBulkAction, rawAction);
  await withEditableJob(db, shop, rawJobId, async (tx, job) => {
    const ofThisJob = and(eq(importRows.jobId, job.id), eq(importRows.shopId, shop.id));
    if (action === "set_missing_currency") {
      // The seller's explicit statement about the rows where the source said nothing.
      await tx
        .update(importRows)
        .set({ currency: shop.currency })
        .where(and(ofThisJob, isNull(importRows.currency), ne(importRows.status, "removed")));
      return;
    }
    // Rows with any doubt stay pending, so each of those gets its own decision.
    const rows = await tx
      .select()
      .from(importRows)
      .where(and(ofThisJob, eq(importRows.status, "pending")));
    const duplicates = findDuplicateTitles(
      await tx.select().from(importRows).where(ofThisJob),
    );
    const clean = rows
      .filter((row) => toRowView(row, shop.currency, duplicates).issues.length === 0)
      .map((row) => row.id);
    if (clean.length > 0) {
      await tx
        .update(importRows)
        .set({ status: "accepted" })
        .where(and(ofThisJob, inArray(importRows.id, clean)));
    }
  });
  return getImport(db, shop, rawJobId);
}

// The gate before publication. Every row must have been decided, and an accepted row can only be
// one with nothing blocking it. Publication reads the accepted rows of a completed import.
export async function finishImportReview(
  db: Db,
  shop: SellerShop,
  rawJobId: unknown,
): Promise<ImportView> {
  await withEditableJob(db, shop, rawJobId, async (tx, job) => {
    const rows = await tx
      .select()
      .from(importRows)
      .where(and(eq(importRows.jobId, job.id), eq(importRows.shopId, shop.id)))
      .orderBy(asc(importRows.position));

    const undecided = rows.filter(
      (row) =>
        row.status === "pending" ||
        (row.status === "accepted" && hasBlocker(rowIssues(row, shop.currency))),
    );
    if (undecided.length > 0) {
      throw new ServiceError(
        "IMPORT_REVIEW_INCOMPLETE",
        `${undecided.length} ${undecided.length === 1 ? "row still needs" : "rows still need"} a decision. Accept or remove each one.`,
        { rows: undecided.map((row) => ({ id: row.id, sourceRef: row.sourceRef })) },
      );
    }
    if (!rows.some((row) => row.status === "accepted")) {
      throw new ServiceError(
        "IMPORT_REVIEW_INCOMPLETE",
        "Accept at least one row, or leave this import unfinished.",
      );
    }
    await tx
      .update(importJobs)
      .set({ status: "completed" })
      .where(eq(importJobs.id, job.id));
    // The review was what the photo was kept for.
    await tx.delete(importSources).where(eq(importSources.jobId, job.id));
  });
  return getImport(db, shop, rawJobId);
}

export async function retryImport(
  db: Db,
  shop: SellerShop,
  rawJobId: unknown,
  deps: ImportDeps,
): Promise<ImportView> {
  const job = await findJob(db, shop, rawJobId);
  const view = await buildView(db, shop, job);
  if (job.status !== "failed" || !view.error?.retryable) {
    throw new ServiceError("IMPORT_NOT_RETRYABLE", "This import cannot be tried again. Upload the file again.");
  }
  const queued = await db.transaction(async (tx) => {
    await assertUnderPhotoLimits(tx, shop);
    const [row] = await tx
      .update(importJobs)
      .set({
        status: "queued",
        attempts: 0,
        retries: sql`${importJobs.retries} + 1`,
        error: null,
      })
      .where(and(eq(importJobs.id, job.id), eq(importJobs.status, "failed")))
      .returning();
    return row;
  });
  if (queued) {
    await startRun(db, deps, queued);
  }
  return getImport(db, shop, job.id);
}

export async function readImportSource(
  db: Db,
  shop: SellerShop,
  rawJobId: unknown,
): Promise<{ bytes: Buffer; mediaType: string }> {
  const job = await findJob(db, shop, rawJobId);
  const [source] = await db
    .select({ bytes: importSources.bytes, mediaType: importSources.mediaType })
    .from(importSources)
    .where(and(eq(importSources.jobId, job.id), eq(importSources.shopId, shop.id)));
  if (!source) {
    throw new ServiceError("IMPORT_NOT_FOUND", "This photo is no longer stored.");
  }
  return source;
}

// Fills in one batch of generated descriptions as suggestions on rows that have none, and says how
// many are left, so the page can show progress and a failure keeps what is already done. A seller's
// own text is never overwritten, even if they typed it while the model was answering.
export async function suggestDescriptions(
  db: Db,
  shop: SellerShop,
  rawJobId: unknown,
  deps: Pick<ImportDeps, "ai">,
): Promise<{ view: ImportView; remaining: number }> {
  const job = await findJob(db, shop, rawJobId);
  if (job.status !== "needs_review") {
    throw new ServiceError("IMPORT_NOT_EDITABLE", "This import cannot be changed now.");
  }
  if (!deps.ai) {
    throw new ServiceError(
      "IMPORT_NOT_CONFIGURED",
      "Writing descriptions is not set up on this server.",
    );
  }

  const unwritten = and(
    eq(importRows.jobId, job.id),
    eq(importRows.shopId, shop.id),
    ne(importRows.status, "removed"),
    sql`${importRows.title} IS NOT NULL`,
    isNull(importRows.descriptionEn),
    isNull(importRows.descriptionLv),
    sql`NOT ('suggestion_rejected' = ANY(${importRows.sourceWarnings}))`,
  );
  const rows = await db
    .select()
    .from(importRows)
    .where(unwritten)
    .orderBy(asc(importRows.position))
    .limit(SUGGESTION_BATCH);

  if (rows.length > 0) {
    let reading;
    try {
      reading = await deps.ai.suggestDescriptions(
        rows.map((row) => ({
          position: row.position,
          title: row.title as string,
          kind: row.kind,
          description: row.description,
        })),
      );
    } catch (error) {
      if (error instanceof AiFailure) {
        throw new ServiceError(
          "SUGGESTIONS_UNAVAILABLE",
          "The AI service could not write descriptions just now. Your rows are unchanged. Try again.",
        );
      }
      throw error;
    }

    const answered = new Map(reading.suggestions.map((entry) => [entry.position, entry]));
    await db.transaction(async (tx) => {
      for (const row of rows) {
        const entry = answered.get(row.position);
        const facts = [row.title, row.description];
        const faithful =
          entry &&
          entry.english.trim() !== "" &&
          entry.latvian.trim() !== "" &&
          suggestionKeepsToFacts(entry.english, facts) &&
          suggestionKeepsToFacts(entry.latvian, facts);
        await tx
          .update(importRows)
          .set(
            faithful
              ? {
                  descriptionEn: cleanSourceText(entry.english, MAX_DESCRIPTION_LENGTH).text,
                  descriptionLv: cleanSourceText(entry.latvian, MAX_DESCRIPTION_LENGTH).text,
                }
              : {
                  sourceWarnings: sql`array_append(${importRows.sourceWarnings}, 'suggestion_rejected')`,
                },
          )
          .where(
            and(
              eq(importRows.id, row.id),
              isNull(importRows.descriptionEn),
              isNull(importRows.descriptionLv),
            ),
          );
      }
      await tx
        .update(importJobs)
        .set({
          result: sql`coalesce(${importJobs.result}, '{}'::jsonb) || ${JSON.stringify({
            suggestions: { model: reading.model, promptVersion: reading.promptVersion },
          })}::jsonb`,
        })
        .where(eq(importJobs.id, job.id));
    });
  }

  const [left] = await db.select({ value: count() }).from(importRows).where(unwritten);
  return { view: await getImport(db, shop, job.id), remaining: left.value };
}
