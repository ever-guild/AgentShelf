import { task, type TaskContext } from "@renderinc/sdk/workflows";

import { createImportAi } from "../src/server/ai";
import { createDb } from "../src/server/db/client";
import { runImportJob } from "../src/server/services/import-run";

// The Render Workflows entry point. A task receives only a job ID. The job says which shop it
// belongs to, so a run can never be pointed at another shop's data.
//
// Retries are Render's job here: three attempts in all, matching MAX_ATTEMPTS. A retried attempt
// claims the job again, and a duplicate delivery finds it taken or done and does nothing. A failure
// that repeating cannot change is recorded on the job and returned, so it is not retried.

task(
  {
    name: "extractPriceList",
    timeoutSeconds: 300,
    retry: { maxRetries: 2, waitDurationMs: 5_000, backoffScaling: 2 },
  },
  async function extractPriceList(_context: TaskContext, jobId: string) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    const { db, close } = createDb(connectionString);
    try {
      const result = await runImportJob(db, jobId, createImportAi(process.env));
      if (result.outcome === "retry") {
        throw new Error(`Import run will be retried: ${result.code}`);
      }
      return result;
    } finally {
      await close();
    }
  },
);
