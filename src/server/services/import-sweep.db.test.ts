import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupMigratedDatabase } from "../../../test/database";
import { createShop } from "../../../test/fixtures";
import {
  JPEG,
  createFakeAi,
  createImportHarness,
  extractedItem,
  jobRow,
  rowsOf,
  sourceOf,
} from "../../../test/imports";
import { AiFailure } from "../ai/types";
import { importJobs, importSources } from "../db/schema";
import { MAX_ATTEMPTS, runImportJob } from "./import-run";
import {
  WORKFLOW_TASK,
  configuredWorkflowSlug,
  inProcessRunner,
  workflowRunner,
  type ImportJobRef,
} from "./import-start";
import { sweepImports } from "./import-sweep";
import { createImport, getImport } from "./imports";

const getDb = setupMigratedDatabase();

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorLog.mockRestore();
});

async function uploadPhoto() {
  const shop = await createShop(getDb());
  const harness = createImportHarness();
  const view = await createImport(getDb(), shop, { name: "a.jpg", bytes: JPEG }, harness.deps);
  return { shop, jobId: view.id, ...harness };
}

function recordingRunner() {
  const started: ImportJobRef[] = [];
  const runner = async (_db: unknown, job: ImportJobRef) => {
    started.push(job);
  };
  return { started, runner };
}

const age = (jobId: string, interval: string) =>
  getDb()
    .update(importJobs)
    .set({ updatedAt: sql`now() - ${sql.raw(`interval '${interval}'`)}` })
    .where(eq(importJobs.id, jobId));

const expireSource = (jobId: string) =>
  getDb()
    .update(importSources)
    .set({ expiresAt: sql`now() - interval '1 second'` })
    .where(eq(importSources.jobId, jobId));

async function holdWithLease(jobId: string, attempts: number, expired: boolean) {
  await getDb()
    .update(importJobs)
    .set({
      status: "running",
      attempts,
      runToken: sql`gen_random_uuid()`,
      leaseExpiresAt: expired ? sql`now() - interval '1 second'` : sql`now() + interval '5 minutes'`,
    })
    .where(eq(importJobs.id, jobId));
}

describe("the retention rule", () => {
  it("deletes a photo past its date and leaves a newer one alone", async () => {
    const old = await uploadPhoto();
    const fresh = await uploadPhoto();
    const { runner } = recordingRunner();
    await expireSource(old.jobId);

    await sweepImports(getDb(), runner);

    expect(await sourceOf(getDb(), old.jobId)).toBeUndefined();
    expect(await sourceOf(getDb(), fresh.jobId)).toBeDefined();
    expect((await jobRow(getDb(), old.jobId)).status).toBe("failed");
    expect((await jobRow(getDb(), fresh.jobId)).status).toBe("queued");
  });

  it("keeps the rows of a review when its photo expires", async () => {
    const { shop, jobId, model } = await uploadPhoto();
    model.queue({ items: [extractedItem()] });
    await runImportJob(getDb(), jobId, model.ai);
    await expireSource(jobId);

    await sweepImports(getDb(), recordingRunner().runner);

    const view = await getImport(getDb(), shop, jobId);
    expect(view).toMatchObject({ status: "needs_review", hasSource: false });
    expect(view.rows).toHaveLength(1);
  });

  it("tells the seller to upload again when a waiting job loses its photo", async () => {
    const { shop, jobId } = await uploadPhoto();
    await expireSource(jobId);
    const { started, runner } = recordingRunner();

    await sweepImports(getDb(), runner);

    expect(await jobRow(getDb(), jobId)).toMatchObject({ status: "failed", error: "SOURCE_EXPIRED" });
    expect(started).toEqual([]);
    expect((await getImport(getDb(), shop, jobId)).error).toMatchObject({
      code: "SOURCE_EXPIRED",
      retryable: false,
    });
  });
});

describe("restarting lost runs", () => {
  it("leaves a job that has only just been queued", async () => {
    await uploadPhoto();
    const { started, runner } = recordingRunner();
    await sweepImports(getDb(), runner);
    expect(started).toEqual([]);
  });

  it("restarts a queued job nothing has picked up", async () => {
    const { jobId } = await uploadPhoto();
    await age(jobId, "2 minutes");
    const { started, runner } = recordingRunner();
    await sweepImports(getDb(), runner);
    expect(started.map((job) => job.id)).toEqual([jobId]);
  });

  it("leaves a run whose lease is still live", async () => {
    const { jobId } = await uploadPhoto();
    await holdWithLease(jobId, 1, false);
    await age(jobId, "1 hour");
    const { started, runner } = recordingRunner();
    await sweepImports(getDb(), runner);
    expect(started).toEqual([]);
    expect((await jobRow(getDb(), jobId)).status).toBe("running");
  });

  it("restarts a run that went silent, as after a server restart", async () => {
    const { jobId, model } = await uploadPhoto();
    await holdWithLease(jobId, 1, true);
    const { started, runner } = recordingRunner();
    await sweepImports(getDb(), runner);
    expect(started.map((job) => job.id)).toEqual([jobId]);

    model.queue({ items: [extractedItem()] });
    await expect(runImportJob(getDb(), jobId, model.ai)).resolves.toMatchObject({
      outcome: "needs_review",
    });
    expect(await rowsOf(getDb(), jobId)).toHaveLength(1);
  });

  it("gives up on a job whose every attempt went silent", async () => {
    const { jobId } = await uploadPhoto();
    await holdWithLease(jobId, MAX_ATTEMPTS, true);
    const { started, runner } = recordingRunner();
    await sweepImports(getDb(), runner);
    expect(started).toEqual([]);
    expect(await jobRow(getDb(), jobId)).toMatchObject({
      status: "failed",
      error: "RUN_ABANDONED",
      runToken: null,
      leaseExpiresAt: null,
    });
  });

  it("fails a job that never starts, rather than leaving the seller waiting", async () => {
    const { shop, jobId } = await uploadPhoto();
    await age(jobId, "16 minutes");
    await sweepImports(getDb(), recordingRunner().runner);
    expect((await getImport(getDb(), shop, jobId)).error).toMatchObject({
      code: "RUN_NOT_STARTED",
      retryable: true,
    });
  });

  it("is bounded per pass, oldest first", async () => {
    const jobs = [];
    for (let index = 0; index < 7; index += 1) {
      const { jobId } = await uploadPhoto();
      await age(jobId, `${10 - index} minutes`);
      jobs.push(jobId);
    }
    const { started, runner } = recordingRunner();
    await sweepImports(getDb(), runner);
    expect(started.map((job) => job.id)).toEqual(jobs.slice(0, 5));
  });

  it("carries on when one restart fails, logging no detail", async () => {
    const first = await uploadPhoto();
    const second = await uploadPhoto();
    await age(first.jobId, "3 minutes");
    await age(second.jobId, "2 minutes");
    const started: string[] = [];
    await sweepImports(getDb(), async (_db, job) => {
      if (job.id === first.jobId) {
        throw new Error("SECRET render detail");
      }
      started.push(job.id);
    });
    expect(started).toEqual([second.jobId]);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("SECRET");
  });

  it("leaves finished and failed jobs alone", async () => {
    const reviewed = await uploadPhoto();
    reviewed.model.queue({ items: [extractedItem()] });
    await runImportJob(getDb(), reviewed.jobId, reviewed.model.ai);
    await age(reviewed.jobId, "1 hour");

    const failed = await uploadPhoto();
    failed.model.queue(new AiFailure("REFUSED"));
    await runImportJob(getDb(), failed.jobId, failed.model.ai);
    await age(failed.jobId, "1 hour");

    const { started, runner } = recordingRunner();
    await sweepImports(getDb(), runner);
    expect(started).toEqual([]);
    expect((await jobRow(getDb(), reviewed.jobId)).status).toBe("needs_review");
    expect(await jobRow(getDb(), failed.jobId)).toMatchObject({ status: "failed", error: "REFUSED" });
  });
});

describe("starting a run through Render Workflows", () => {
  function fakeWorkflows() {
    const calls: { slug: string; input: unknown[]; key: string }[] = [];
    return {
      calls,
      client: {
        startTask: async (slug: string, input: unknown[], options: { idempotencyKey: string }) => {
          calls.push({ slug, input, key: options.idempotencyKey });
          return { taskRunId: `run-${calls.length}` };
        },
      },
    };
  }

  it("passes only the job's ID, and records the run", async () => {
    const { jobId } = await uploadPhoto();
    const { calls, client } = fakeWorkflows();
    const job = await jobRow(getDb(), jobId);

    await workflowRunner(client, "agentshelf-import")(getDb(), job);

    expect(calls).toEqual([
      {
        slug: `agentshelf-import/${WORKFLOW_TASK}`,
        input: [jobId],
        key: `${jobId}:${job.updatedAt.getTime()}`,
      },
    ]);
    expect((await jobRow(getDb(), jobId)).workflowRunId).toBe("run-1");
  });

  it("does not move the sweep's clock by recording a run", async () => {
    const { jobId } = await uploadPhoto();
    await age(jobId, "10 minutes");
    const before = await jobRow(getDb(), jobId);
    await workflowRunner(fakeWorkflows().client, "w")(getDb(), before);
    expect((await jobRow(getDb(), jobId)).updatedAt).toEqual(before.updatedAt);
  });

  it("uses the same key to start an unchanged job twice, so only one run exists", async () => {
    const { jobId } = await uploadPhoto();
    const { calls, client } = fakeWorkflows();
    await workflowRunner(client, "w")(getDb(), await jobRow(getDb(), jobId));
    await workflowRunner(client, "w")(getDb(), await jobRow(getDb(), jobId));
    expect(calls[0].key).toBe(calls[1].key);
  });

  it("uses a new key once the job has moved, so a retry is not answered with the old run", async () => {
    const { jobId, model } = await uploadPhoto();
    const { calls, client } = fakeWorkflows();
    await workflowRunner(client, "w")(getDb(), await jobRow(getDb(), jobId));
    model.queue(new AiFailure("PROVIDER_UNAVAILABLE"));
    await runImportJob(getDb(), jobId, model.ai);
    await workflowRunner(client, "w")(getDb(), await jobRow(getDb(), jobId));
    expect(calls[0].key).not.toBe(calls[1].key);
  });
});

describe("running in the server process", () => {
  it("retries until it has an answer", async () => {
    const { jobId } = await uploadPhoto();
    const model = createFakeAi();
    model.queue(new AiFailure("PROVIDER_UNAVAILABLE"), { items: [extractedItem()] });

    await inProcessRunner(model.ai, 0)(getDb(), await jobRow(getDb(), jobId));

    await vi.waitFor(async () => {
      expect((await jobRow(getDb(), jobId)).status).toBe("needs_review");
    });
    expect(model.images).toHaveLength(2);
  });

  it("stops at the attempt limit", async () => {
    const { jobId } = await uploadPhoto();
    const model = createFakeAi();
    model.queue(
      new AiFailure("MALFORMED_OUTPUT"),
      new AiFailure("MALFORMED_OUTPUT"),
      new AiFailure("MALFORMED_OUTPUT"),
    );
    await inProcessRunner(model.ai, 0)(getDb(), await jobRow(getDb(), jobId));
    await vi.waitFor(async () => {
      expect(await jobRow(getDb(), jobId)).toMatchObject({
        status: "failed",
        error: "MALFORMED_OUTPUT",
      });
    });
    expect(model.images).toHaveLength(MAX_ATTEMPTS);
  });

  it("holds back past its limit, leaving the job queued for the sweep", async () => {
    const jobs = await Promise.all([uploadPhoto(), uploadPhoto(), uploadPhoto()]);
    const model = createFakeAi();
    const releases: (() => void)[] = [];
    const held = () =>
      new Promise<{ items: ReturnType<typeof extractedItem>[] }>((resolve) => {
        releases.push(() => resolve({ items: [extractedItem()] }));
      });
    model.queue(held, held);
    const runner = inProcessRunner(model.ai, 0);

    await runner(getDb(), await jobRow(getDb(), jobs[0].jobId));
    await runner(getDb(), await jobRow(getDb(), jobs[1].jobId));
    await vi.waitFor(() => expect(releases).toHaveLength(2));

    await runner(getDb(), await jobRow(getDb(), jobs[2].jobId));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await jobRow(getDb(), jobs[2].jobId)).toMatchObject({ status: "queued", attempts: 0 });
    expect(model.images).toHaveLength(2);

    releases.forEach((release) => release());
    await vi.waitFor(async () => {
      expect((await jobRow(getDb(), jobs[1].jobId)).status).toBe("needs_review");
    });
    await vi.waitFor(async () => {
      expect((await jobRow(getDb(), jobs[0].jobId)).status).toBe("needs_review");
    });

    // Room again, so the next start runs.
    model.queue({ items: [extractedItem()] });
    await vi.waitFor(async () => {
      await runner(getDb(), await jobRow(getDb(), jobs[2].jobId));
      expect((await jobRow(getDb(), jobs[2].jobId)).status).not.toBe("queued");
    });
  });
});

describe("choosing how to run", () => {
  it.each([
    [{}, undefined],
    [{ RENDER_WORKFLOW_SLUG: "w" }, undefined],
    [{ RENDER_API_KEY: "k" }, undefined],
    [{ RENDER_WORKFLOW_SLUG: "", RENDER_API_KEY: "k" }, undefined],
    [{ RENDER_WORKFLOW_SLUG: "w", RENDER_USE_LOCAL_DEV: "false" }, undefined],
    [{ RENDER_WORKFLOW_SLUG: "w", RENDER_API_KEY: "k" }, "w"],
    [{ RENDER_WORKFLOW_SLUG: "w", RENDER_USE_LOCAL_DEV: "true" }, "w"],
  ])("uses a workflow for %j only when it can reach one", (env, slug) => {
    expect(configuredWorkflowSlug(env)).toBe(slug);
  });
});
