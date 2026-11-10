import { task, type TaskContext } from "@renderinc/sdk/workflows";

import { createImportAi } from "../src/server/ai";
import type { ImportAi } from "../src/server/ai/types";
import { createDb } from "../src/server/db/client";
import {
  runImportJob,
  type ImportRunOutcome,
} from "../src/server/services/import-run";
import {
  readWorkflowRevision,
  registerWorkflowRevisionTask,
} from "./revision";

// Render can attest this release by finding the revision-named task in the released version.
// Local development has no generated artifact and continues to register only the import task.
registerWorkflowRevisionTask(
  readWorkflowRevision(),
  process.env.RENDER === "true",
);

// The Render Workflows entry point. A task receives only a job ID. The job says which shop it
// belongs to, so a run can never be pointed at another shop's data.
//
// Retries are Render's job here: three attempts in all, matching MAX_ATTEMPTS. A retried attempt
// claims the job again, and a duplicate delivery finds it taken or done and does nothing. A failure
// that repeating cannot change is recorded on the job and returned, so it is not retried.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ExtractPriceListResult =
  ImportRunOutcome | { outcome: "failed"; code: "INVALID_INPUT" };

export type ExtractPriceListDeps = {
  createDb: typeof createDb;
  runImportJob: (
    db: Parameters<typeof runImportJob>[0],
    jobId: string,
    ai: ImportAi | undefined,
  ) => Promise<ImportRunOutcome>;
  createImportAi: (
    env: Record<string, string | undefined>,
  ) => ImportAi | undefined;
  env: Record<string, string | undefined>;
};

const defaultDeps: ExtractPriceListDeps = {
  createDb,
  runImportJob,
  createImportAi,
  get env() {
    return process.env;
  },
};

export async function extractPriceList(
  context: Pick<TaskContext, "metadata">,
  jobId: unknown,
  deps: ExtractPriceListDeps = defaultDeps,
): Promise<ExtractPriceListResult> {
  const taskRunId = context.metadata?.taskRunId;
  if (typeof jobId !== "string" || !UUID.test(jobId)) {
    // Repeating cannot fix a bad argument, so this is returned and not thrown.
    console.error("Import task rejected", {
      taskRunId,
      outcome: "invalid_input",
    });
    return { outcome: "failed", code: "INVALID_INPUT" };
  }
  const connectionString = deps.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  console.info("Import task started", { jobId, taskRunId });
  const { db, close } = deps.createDb(connectionString);
  try {
    const result = await deps.runImportJob(
      db,
      jobId,
      deps.createImportAi(deps.env),
    );
    console.info("Import task finished", {
      jobId,
      taskRunId,
      outcome: result.outcome,
    });
    if (result.outcome === "retry") {
      throw new Error(`Import run will be retried: ${result.code}`);
    }
    return result;
  } catch (error) {
    console.error("Import task failed", {
      jobId,
      taskRunId,
      outcome: "error",
      errorName: error instanceof Error ? error.name : "unknown",
    });
    throw error;
  } finally {
    await close();
  }
}

task(
  {
    name: "extractPriceList",
    timeoutSeconds: 300,
    retry: { maxRetries: 2, waitDurationMs: 5_000, backoffScaling: 2 },
  },
  (context: TaskContext, jobId: string) => extractPriceList(context, jobId),
);
