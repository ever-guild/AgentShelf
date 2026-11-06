import "server-only";

import { eq, sql } from "drizzle-orm";

import { createImportAi } from "../ai";
import type { ImportAi } from "../ai/types";
import type { Db } from "../db/client";
import { importJobs } from "../db/schema";
import { MAX_ATTEMPTS, runImportJob } from "./import-run";

// Starts a photo import's run: through Render Workflows when that is configured, otherwise inside
// this server process. Both run the same function, so what differs is how far a run gets from the
// web service. Local development, and a deployment with no workflow service, still work.

export const WORKFLOW_TASK = "extractPriceList";
const IN_PROCESS_LIMIT = 2;
const IN_PROCESS_BACKOFF_MS = 5_000;
// An upload should not hang on another service. A start that does not answer is tried again.
const START_TIMEOUT_MS = 10_000;

export type ImportJobRef = { id: string; updatedAt: Date };

export type ImportRunner = (db: Db, job: ImportJobRef) => Promise<void>;

type Env = Record<string, string | undefined>;

type WorkflowClient = {
  startTask(
    slug: string,
    input: unknown[],
    options: { idempotencyKey: string; signal: AbortSignal },
  ): Promise<{ taskRunId: string }>;
};

// The key changes only when the job does, so starting a job again that has not moved cannot start
// a second run, and a job that has moved since its last run can start another. A run's arguments
// hold only the job's ID: a shop can never be named from outside, and no photo goes through Render.
export function workflowRunner(client: WorkflowClient, workflowSlug: string): ImportRunner {
  return async (db, job) => {
    const run = await client.startTask(`${workflowSlug}/${WORKFLOW_TASK}`, [job.id], {
      idempotencyKey: `${job.id}:${job.updatedAt.getTime()}`,
      signal: AbortSignal.timeout(START_TIMEOUT_MS),
    });
    // Recording a run is not progress, so the sweep's clock for a job that never starts keeps going.
    await db
      .update(importJobs)
      .set({ workflowRunId: run.taskRunId, updatedAt: sql`${importJobs.updatedAt}` })
      .where(eq(importJobs.id, job.id));
  };
}

let activeInProcess = 0;

export function inProcessRunner(
  ai: ImportAi | undefined,
  backoffMs: number = IN_PROCESS_BACKOFF_MS,
): ImportRunner {
  return async (db, job) => {
    // A job left queued here is picked up by the sweep when there is room.
    if (activeInProcess >= IN_PROCESS_LIMIT) {
      return;
    }
    activeInProcess += 1;
    void (async () => {
      try {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
          const result = await runImportJob(db, job.id, ai);
          if (result.outcome !== "retry") {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
        }
      } catch (error) {
        console.error("Import run stopped", {
          error: error instanceof Error ? error.name : "unknown",
        });
      } finally {
        activeInProcess -= 1;
      }
    })();
  };
}

// The Render SDK is loaded only when it is used, because the web service otherwise never needs it.
function renderWorkflowRunner(workflowSlug: string): ImportRunner {
  let runner: Promise<ImportRunner> | undefined;
  return async (db, job) => {
    runner ??= import("@renderinc/sdk").then(({ Render }) => {
      const { workflows } = new Render();
      return workflowRunner(workflows, workflowSlug);
    });
    const start = await runner;
    await start(db, job);
  };
}

// A workflow is used only when it is named and Render can be reached.
export function configuredWorkflowSlug(env: Env): string | undefined {
  const canReachRender = Boolean(env.RENDER_API_KEY) || env.RENDER_USE_LOCAL_DEV === "true";
  return canReachRender ? env.RENDER_WORKFLOW_SLUG || undefined : undefined;
}

export type ImportDeps = { ai: ImportAi | undefined; startRun: ImportRunner };

let defaults: ImportDeps | undefined;

export function defaultImportDeps(): ImportDeps {
  if (!defaults) {
    const ai = createImportAi(process.env);
    const slug = configuredWorkflowSlug(process.env);
    defaults = { ai, startRun: slug ? renderWorkflowRunner(slug) : inProcessRunner(ai) };
  }
  return defaults;
}
