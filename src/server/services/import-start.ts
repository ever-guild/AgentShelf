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

function httpStatus(error: unknown): number | undefined {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" && Number.isInteger(status)
    ? status
    : undefined;
}

// The key changes only when the job does, so starting a job again that has not moved cannot start
// a second run, and a job that has moved since its last run can start another. A run's arguments
// hold only the job's ID: a shop can never be named from outside, and no photo goes through Render.
export function workflowRunner(
  client: WorkflowClient,
  workflowSlug: string,
): ImportRunner {
  return async (db, job) => {
    let run: { taskRunId: string };
    try {
      run = await client.startTask(
        `${workflowSlug}/${WORKFLOW_TASK}`,
        [job.id],
        {
          idempotencyKey: `${job.id}:${job.updatedAt.getTime()}`,
          signal: AbortSignal.timeout(START_TIMEOUT_MS),
        },
      );
    } catch (error) {
      // Only the job ID, the error's name and a numeric status: a message could hold a request body.
      console.error("Render Workflow start failed", {
        jobId: job.id,
        ...(httpStatus(error) === undefined
          ? {}
          : { status: httpStatus(error) }),
        errorName: error instanceof Error ? error.name : "unknown",
      });
      throw error;
    }
    console.info("Import run started", {
      jobId: job.id,
      runner: "render-workflow",
      taskRunId: run.taskRunId,
    });
    // Recording a run is not progress, so the sweep's clock for a job that never starts keeps going.
    await db
      .update(importJobs)
      .set({
        workflowRunId: run.taskRunId,
        updatedAt: sql`${importJobs.updatedAt}`,
      })
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
    console.info("Import run started", {
      jobId: job.id,
      runner: "web-process",
    });
    void (async () => {
      try {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
          const result = await runImportJob(db, job.id, ai);
          if (result.outcome !== "retry") {
            return;
          }
          await new Promise((resolve) =>
            setTimeout(resolve, backoffMs * attempt),
          );
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

export type WorkflowClientFactory = () => Promise<WorkflowClient>;

const loadRenderClient: WorkflowClientFactory = async () => {
  const { Render } = await import("@renderinc/sdk");
  return new Render().workflows;
};

// The Render SDK is loaded only when it is used, because the web service otherwise never needs it.
// A failed load or construction is not kept, so the next start (the sweep's) tries again.
export function renderWorkflowRunner(
  workflowSlug: string,
  createClient: WorkflowClientFactory = loadRenderClient,
): ImportRunner {
  let runner: Promise<ImportRunner> | undefined;
  return async (db, job) => {
    if (!runner) {
      const pending = createClient().then((client) =>
        workflowRunner(client, workflowSlug),
      );
      runner = pending;
      pending.catch(() => {
        if (runner === pending) {
          runner = undefined;
        }
      });
    }
    const start = await runner;
    await start(db, job);
  };
}

function canReachRender(
  env: Env,
): { ok: true } | { ok: false; reason: string } {
  if (env.RENDER_API_KEY) return { ok: true };
  if (env.RENDER_USE_LOCAL_DEV === "true" || env.RENDER_LOCAL_DEV_URL?.trim())
    return { ok: true };
  return { ok: false, reason: "RENDER_API_KEY_MISSING" };
}

export type ImportRunMode = {
  mode: "render-workflow" | "web-process";
  slug?: string;
  reason?: string;
};

// Where photo imports run, and when that is not where they were meant to, why.
export function importRunMode(env: Env): ImportRunMode {
  const slug = env.RENDER_WORKFLOW_SLUG || undefined;
  if (!slug) return { mode: "web-process" };
  const reach = canReachRender(env);
  return reach.ok
    ? { mode: "render-workflow", slug }
    : { mode: "web-process", reason: reach.reason };
}

// A workflow is used only when it is named and Render can be reached.
export function configuredWorkflowSlug(env: Env): string | undefined {
  return importRunMode(env).slug;
}

export type ImportDeps = { ai: ImportAi | undefined; startRun: ImportRunner };

let defaults: ImportDeps | undefined;

export function defaultImportDeps(): ImportDeps {
  if (!defaults) {
    const ai = createImportAi(process.env);
    const { slug, reason } = importRunMode(process.env);
    if (reason) {
      console.warn(
        "Render Workflow configured but not reachable; photo imports run in the web process",
        {
          reason,
        },
      );
    }
    defaults = {
      ai,
      startRun: slug ? renderWorkflowRunner(slug) : inProcessRunner(ai),
    };
  }
  return defaults;
}
