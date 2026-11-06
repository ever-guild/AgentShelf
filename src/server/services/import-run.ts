import { randomUUID } from "node:crypto";

import { and, eq, lt, lte, or, sql } from "drizzle-orm";

import { AiFailure, type ImportAi } from "../ai/types";
import type { Db } from "../db/client";
import { importJobs, importRows, importSources } from "../db/schema";
import { MAX_ROWS_PER_IMPORT } from "../imports/draft-rows";
import { draftRowsFromExtraction } from "../imports/extraction";
import { IMAGE_MEDIA_TYPES, type ImageMediaType } from "../imports/file-type";

// Runs one photo import: reads the photo with a model and stores draft rows. A workflow task and
// the web process both call this, and they can call it repeatedly and at the same time, so it is
// built around one rule: a run owns a job only while it holds the job's current token, and only
// that run can finish it. Whatever is delivered twice, restarted or left behind, one result is
// stored, and it belongs to the shop named on the job. The caller passes only a job ID.
//
// No `server-only` guard here: see the note in ai/claude.ts.

export const MAX_ATTEMPTS = 3;
// Longer than a workflow task's five-minute limit, so a live run is never taken over.
const LEASE = sql`interval '6 minutes'`;

export type ImportRunCode =
  | AiFailure["code"]
  | "NOTHING_FOUND"
  | "NOT_CONFIGURED"
  | "SOURCE_EXPIRED"
  | "RUN_ABANDONED"
  | "RUN_NOT_STARTED"
  | "INTERNAL";

export type ImportRunOutcome =
  | { outcome: "skipped" }
  | { outcome: "needs_review"; rowCount: number }
  // The job is queued again. A caller with a retry policy should run it again later.
  | { outcome: "retry"; code: ImportRunCode }
  | { outcome: "failed"; code: ImportRunCode };

function isImageMediaType(value: string): value is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

// A queued job, or one whose run went silent past its lease. The attempt limit bounds what a crash
// can cost: a job that keeps killing its runs stops being picked up, and the sweep records why.
async function claimJob(db: Db, jobId: string) {
  const runToken = randomUUID();
  const [job] = await db
    .update(importJobs)
    .set({
      status: "running",
      runToken,
      leaseExpiresAt: sql`now() + ${LEASE}`,
      attempts: sql`${importJobs.attempts} + 1`,
      error: null,
    })
    .where(
      and(
        eq(importJobs.id, jobId),
        eq(importJobs.sourceKind, "photo"),
        lt(importJobs.attempts, MAX_ATTEMPTS),
        or(
          eq(importJobs.status, "queued"),
          and(eq(importJobs.status, "running"), lte(importJobs.leaseExpiresAt, sql`now()`)),
        ),
      ),
    )
    .returning({ shopId: importJobs.shopId, attempts: importJobs.attempts });
  return job ? { ...job, runToken } : undefined;
}

type Claim = NonNullable<Awaited<ReturnType<typeof claimJob>>>;

const heldBy = (jobId: string, runToken: string) =>
  and(
    eq(importJobs.id, jobId),
    eq(importJobs.status, "running"),
    eq(importJobs.runToken, runToken),
  );

// The status change and the rows commit together, and only for the run that still holds the job. A
// run that lost its lease writes nothing, and the unique position per job backs that up.
async function storeResult(
  db: Db,
  jobId: string,
  claim: Claim,
  rows: ReturnType<typeof draftRowsFromExtraction>,
  reading: { model: string; promptVersion: string; usage: unknown },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [finished] = await tx
      .update(importJobs)
      .set({
        status: "needs_review",
        runToken: null,
        leaseExpiresAt: null,
        error: null,
        model: reading.model,
        promptVersion: reading.promptVersion,
        result: { rowCount: rows.length, usage: reading.usage },
      })
      .where(heldBy(jobId, claim.runToken))
      .returning({ id: importJobs.id });
    if (!finished) {
      return false;
    }
    await tx
      .insert(importRows)
      .values(rows.map((row) => ({ ...row, jobId, shopId: claim.shopId })));
    return true;
  });
}

async function recordFailure(db: Db, jobId: string, claim: Claim, code: ImportRunCode) {
  const [failed] = await db
    .update(importJobs)
    .set({ status: "failed", runToken: null, leaseExpiresAt: null, error: code })
    .where(heldBy(jobId, claim.runToken))
    .returning({ id: importJobs.id });
  return failed ? ({ outcome: "failed", code } as const) : ({ outcome: "skipped" } as const);
}

async function requeue(db: Db, jobId: string, claim: Claim, code: ImportRunCode) {
  const [queued] = await db
    .update(importJobs)
    .set({ status: "queued", runToken: null, leaseExpiresAt: null, error: code })
    .where(heldBy(jobId, claim.runToken))
    .returning({ id: importJobs.id });
  return queued ? ({ outcome: "retry", code } as const) : ({ outcome: "skipped" } as const);
}

async function settleTransientFailure(
  db: Db,
  jobId: string,
  claim: Claim,
  code: ImportRunCode,
): Promise<ImportRunOutcome> {
  return claim.attempts < MAX_ATTEMPTS
    ? requeue(db, jobId, claim, code)
    : recordFailure(db, jobId, claim, code);
}

export async function runImportJob(
  db: Db,
  jobId: string,
  ai: ImportAi | undefined,
): Promise<ImportRunOutcome> {
  const claim = await claimJob(db, jobId);
  if (!claim) {
    return { outcome: "skipped" };
  }

  try {
    if (!ai) {
      return await recordFailure(db, jobId, claim, "NOT_CONFIGURED");
    }
    const [source] = await db
      .select({ bytes: importSources.bytes, mediaType: importSources.mediaType })
      .from(importSources)
      .where(and(eq(importSources.jobId, jobId), eq(importSources.shopId, claim.shopId)));
    if (!source || !isImageMediaType(source.mediaType)) {
      return await recordFailure(db, jobId, claim, "SOURCE_EXPIRED");
    }

    const reading = await ai.readPriceList({
      bytes: source.bytes,
      mediaType: source.mediaType,
    });

    const rows = draftRowsFromExtraction(reading.items);
    if (rows.length === 0) {
      return await recordFailure(db, jobId, claim, "NOTHING_FOUND");
    }
    if (rows.length > MAX_ROWS_PER_IMPORT) {
      return await recordFailure(db, jobId, claim, "TOO_LONG");
    }

    const stored = await storeResult(db, jobId, claim, rows, reading);
    return stored
      ? { outcome: "needs_review", rowCount: rows.length }
      : { outcome: "skipped" };
  } catch (error) {
    if (error instanceof AiFailure) {
      return error.retriedAutomatically
        ? await settleTransientFailure(db, jobId, claim, error.code)
        : await recordFailure(db, jobId, claim, error.code);
    }
    console.error("Import run failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return settleTransientFailure(db, jobId, claim, "INTERNAL");
  }
}
