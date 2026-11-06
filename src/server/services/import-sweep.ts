import "server-only";

import { and, asc, eq, gte, lt, lte, notExists, or, sql } from "drizzle-orm";

import { getDb } from "../db";
import type { Db } from "../db/client";
import { importJobs, importSources } from "../db/schema";
import { MAX_ATTEMPTS } from "./import-run";
import { defaultImportDeps, type ImportRunner } from "./import-start";

// Keeps photo imports moving and their files short-lived. It deletes photos past their retention
// date, restarts runs that were lost to a restart or that never started, and fails what cannot make
// progress, so a job always ends in a state its seller can see. It starts runs and nothing more, so
// it cannot complete a job twice: run ownership in import-run.ts decides that.
const SWEEP_INTERVAL_MS = 60 * 1000;
const SWEEP_BATCH = 5;
// A job this recent may simply be starting.
const QUEUED_GRACE = sql`interval '1 minute'`;
const NEVER_STARTED = sql`interval '15 minutes'`;

export async function sweepImports(db: Db, runner: ImportRunner): Promise<void> {
  await db.delete(importSources).where(lte(importSources.expiresAt, sql`now()`));

  const noSource = notExists(
    db.select({ id: importSources.jobId }).from(importSources).where(eq(importSources.jobId, importJobs.id)),
  );

  // A job with no photo left can never run, and the seller has to upload it again.
  await db
    .update(importJobs)
    .set({ status: "failed", error: "SOURCE_EXPIRED", runToken: null, leaseExpiresAt: null })
    .where(
      and(
        eq(importJobs.sourceKind, "photo"),
        noSource,
        or(
          eq(importJobs.status, "queued"),
          and(eq(importJobs.status, "running"), lte(importJobs.leaseExpiresAt, sql`now()`)),
        ),
      ),
    );

  // Every attempt ended in a crash or a timeout.
  await db
    .update(importJobs)
    .set({ status: "failed", error: "RUN_ABANDONED", runToken: null, leaseExpiresAt: null })
    .where(
      and(
        eq(importJobs.status, "running"),
        lte(importJobs.leaseExpiresAt, sql`now()`),
        gte(importJobs.attempts, MAX_ATTEMPTS),
      ),
    );

  // Nothing ever picked it up, as when the workflow service is unreachable or out of credit.
  await db
    .update(importJobs)
    .set({ status: "failed", error: "RUN_NOT_STARTED" })
    .where(
      and(
        eq(importJobs.status, "queued"),
        lt(importJobs.updatedAt, sql`now() - ${NEVER_STARTED}`),
      ),
    );

  const due = await db
    .select({ id: importJobs.id, updatedAt: importJobs.updatedAt })
    .from(importJobs)
    .where(
      or(
        and(
          eq(importJobs.status, "queued"),
          lt(importJobs.updatedAt, sql`now() - ${QUEUED_GRACE}`),
        ),
        and(
          eq(importJobs.status, "running"),
          lte(importJobs.leaseExpiresAt, sql`now()`),
          lt(importJobs.attempts, MAX_ATTEMPTS),
        ),
      ),
    )
    .orderBy(asc(importJobs.updatedAt))
    .limit(SWEEP_BATCH);

  for (const job of due) {
    await runner(db, job).catch((error: unknown) => {
      console.error("Could not restart an import run", {
        error: error instanceof Error ? error.name : "unknown",
      });
    });
  }
}

export function startImportSweep(): void {
  let running = false;
  setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    sweepImports(getDb(), defaultImportDeps().startRun)
      .catch((error: unknown) => {
        console.error("Import sweep failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      })
      .finally(() => {
        running = false;
      });
  }, SWEEP_INTERVAL_MS).unref();
}
