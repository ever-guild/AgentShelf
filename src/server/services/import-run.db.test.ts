import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeClaude } from "../../../test/claude-fake";
import { setupMigratedDatabase } from "../../../test/database";
import { createShop, violatedConstraint } from "../../../test/fixtures";
import {
  JPEG,
  PNG,
  createFakeAi,
  createImportHarness,
  extractedItem,
  jobRow,
  rowsOf,
  sourceOf,
} from "../../../test/imports";
import { createClaudeAi } from "../ai/claude";
import { AiFailure } from "../ai/types";
import { importJobs, importRows, importSources } from "../db/schema";
import { MAX_ROWS_PER_IMPORT } from "../imports/draft-rows";
import { MAX_ATTEMPTS, runImportJob } from "./import-run";
import { getImport, createImport, retryImport } from "./imports";

const getDb = setupMigratedDatabase();

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorLog.mockRestore();
});

async function uploadPhoto(shopOverrides = {}, bytes: Buffer = JPEG) {
  const shop = await createShop(getDb(), shopOverrides);
  const harness = createImportHarness();
  const view = await createImport(
    getDb(),
    shop,
    { name: "prices.jpg", bytes },
    harness.deps,
  );
  return { shop, jobId: view.id, ...harness };
}

const expireLease = (jobId: string) =>
  getDb()
    .update(importJobs)
    .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
    .where(eq(importJobs.id, jobId));

describe("a successful run", () => {
  it("stores draft rows, the model and the prompt version, and asks for review", async () => {
    const { shop, jobId, model } = await uploadPhoto();
    model.queue({ items: [extractedItem(), extractedItem({ name: "Cable", priceText: "5 €" })] });

    await expect(runImportJob(getDb(), jobId, model.ai)).resolves.toEqual({
      outcome: "needs_review",
      rowCount: 2,
    });

    const job = await jobRow(getDb(), jobId);
    expect(job).toMatchObject({
      status: "needs_review",
      model: "fake-model",
      promptVersion: "fake-prompt-v1",
      runToken: null,
      leaseExpiresAt: null,
      attempts: 1,
      error: null,
    });
    expect(job.result).toEqual({
      rowCount: 2,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect((await rowsOf(getDb(), jobId)).map((row) => [row.shopId, row.title, row.priceMinor])).toEqual([
      [shop.id, "Tempered glass", 990],
      [shop.id, "Cable", 500],
    ]);
  });

  it("reads the job's own photo", async () => {
    const { jobId, model } = await uploadPhoto();
    model.queue({ items: [extractedItem()] });
    await runImportJob(getDb(), jobId, model.ai);
    expect(model.images).toEqual([JPEG]);
  });

  it("keeps the photo for the review", async () => {
    const { jobId, model } = await uploadPhoto();
    model.queue({ items: [extractedItem()] });
    await runImportJob(getDb(), jobId, model.ai);
    expect(await sourceOf(getDb(), jobId)).toBeDefined();
  });

  it("runs through the real adapter from a stored photo to rows", async () => {
    const { jobId } = await uploadPhoto();
    const fake = createFakeClaude();
    const ai = createClaudeAi({ ANTHROPIC_API_KEY: "test-key" }, { fetch: fake.fetch });
    fake.replyJson({ items: [extractedItem({ priceText: "12,50 €" })] });

    await expect(runImportJob(getDb(), jobId, ai)).resolves.toMatchObject({
      outcome: "needs_review",
    });
    const job = await jobRow(getDb(), jobId);
    expect(job.model).toBe("claude-opus-5-5");
    expect(job.promptVersion).toBe("price-list-v1");
    expect((await rowsOf(getDb(), jobId))[0]).toMatchObject({ priceMinor: 1250, currency: "EUR" });
    expect(fake.requests[0].body).toMatchObject({
      messages: [{ content: [{ source: { data: JPEG.toString("base64") } }, {}] }],
    });
  });
});

describe("restarts and duplicate delivery keep one result", () => {
  it("does nothing when a finished job is delivered again", async () => {
    const { jobId, model } = await uploadPhoto();
    model.queue({ items: [extractedItem()] });
    await runImportJob(getDb(), jobId, model.ai);
    const before = await rowsOf(getDb(), jobId);

    await expect(runImportJob(getDb(), jobId, model.ai)).resolves.toEqual({ outcome: "skipped" });

    expect(model.images).toHaveLength(1);
    expect(await rowsOf(getDb(), jobId)).toEqual(before);
    expect((await jobRow(getDb(), jobId)).attempts).toBe(1);
  });

  it("gives one of two simultaneous deliveries the job", async () => {
    const { jobId, model } = await uploadPhoto();
    model.queue({ items: [extractedItem()] }, { items: [extractedItem()] });

    const outcomes = await Promise.all([
      runImportJob(getDb(), jobId, model.ai),
      runImportJob(getDb(), jobId, model.ai),
    ]);

    expect(outcomes.map((result) => result.outcome).sort()).toEqual(["needs_review", "skipped"]);
    expect(model.images).toHaveLength(1);
    expect(await rowsOf(getDb(), jobId)).toHaveLength(1);
  });

  it("does not start a job that another run holds", async () => {
    const { jobId, model } = await uploadPhoto();
    let releaseFirst: (value: { items: ReturnType<typeof extractedItem>[] }) => void = () => {};
    model.queue(() => new Promise((resolve) => (releaseFirst = resolve)));
    const first = runImportJob(getDb(), jobId, model.ai);
    await vi.waitFor(() => expect(model.images).toHaveLength(1));

    await expect(runImportJob(getDb(), jobId, model.ai)).resolves.toEqual({ outcome: "skipped" });

    releaseFirst({ items: [extractedItem()] });
    await expect(first).resolves.toMatchObject({ outcome: "needs_review" });
  });

  it("takes over a run that went silent, and resumes after a restart", async () => {
    const { jobId, model } = await uploadPhoto();
    // A process that claimed the job and died.
    await getDb()
      .update(importJobs)
      .set({
        status: "running",
        runToken: sql`gen_random_uuid()`,
        leaseExpiresAt: sql`now() - interval '1 second'`,
        attempts: 1,
      })
      .where(eq(importJobs.id, jobId));
    model.queue({ items: [extractedItem()] });

    await expect(runImportJob(getDb(), jobId, model.ai)).resolves.toMatchObject({
      outcome: "needs_review",
    });
    expect((await jobRow(getDb(), jobId)).attempts).toBe(2);
    expect(await rowsOf(getDb(), jobId)).toHaveLength(1);
  });

  it("discards the result of a run that lost the job, keeping the winner's", async () => {
    const { jobId, model } = await uploadPhoto();
    let finishSlowRun: (value: { items: ReturnType<typeof extractedItem>[] }) => void = () => {};
    model.queue(() => new Promise((resolve) => (finishSlowRun = resolve)));
    const slowRun = runImportJob(getDb(), jobId, model.ai);
    await vi.waitFor(() => expect(model.images).toHaveLength(1));

    await expireLease(jobId);
    model.queue({ items: [extractedItem({ name: "From the second run" })] });
    await expect(runImportJob(getDb(), jobId, model.ai)).resolves.toMatchObject({
      outcome: "needs_review",
    });

    finishSlowRun({ items: [extractedItem({ name: "From the first run" })] });
    await expect(slowRun).resolves.toEqual({ outcome: "skipped" });

    expect((await rowsOf(getDb(), jobId)).map((row) => row.title)).toEqual(["From the second run"]);
    expect((await jobRow(getDb(), jobId)).status).toBe("needs_review");
  });

  it("discards a run that lost the job even while the run that took over is still reading", async () => {
    const { jobId, model } = await uploadPhoto();
    type Reading = { items: ReturnType<typeof extractedItem>[] };
    let finishFirst: (value: Reading) => void = () => {};
    let finishSecond: (value: Reading) => void = () => {};
    model.queue(() => new Promise((resolve) => (finishFirst = resolve)));
    model.queue(() => new Promise((resolve) => (finishSecond = resolve)));

    const first = runImportJob(getDb(), jobId, model.ai);
    await vi.waitFor(() => expect(model.images).toHaveLength(1));
    await expireLease(jobId);
    const second = runImportJob(getDb(), jobId, model.ai);
    await vi.waitFor(() => expect(model.images).toHaveLength(2));

    // Both runs are live now, and the job is `running` for the second one.
    finishFirst({ items: [extractedItem({ name: "From the first run" })] });
    await expect(first).resolves.toEqual({ outcome: "skipped" });
    expect(await rowsOf(getDb(), jobId)).toEqual([]);
    expect((await jobRow(getDb(), jobId)).status).toBe("running");

    finishSecond({ items: [extractedItem({ name: "From the second run" })] });
    await expect(second).resolves.toMatchObject({ outcome: "needs_review" });
    expect((await rowsOf(getDb(), jobId)).map((row) => row.title)).toEqual(["From the second run"]);
  });

  it("does not let a run that lost the job record a failure over the run that took over", async () => {
    const { jobId, model } = await uploadPhoto();
    let failFirst: (error: Error) => void = () => {};
    let finishSecond: (value: { items: ReturnType<typeof extractedItem>[] }) => void = () => {};
    model.queue(() => new Promise((_resolve, reject) => (failFirst = reject)));
    model.queue(() => new Promise((resolve) => (finishSecond = resolve)));

    const first = runImportJob(getDb(), jobId, model.ai);
    await vi.waitFor(() => expect(model.images).toHaveLength(1));
    await expireLease(jobId);
    const second = runImportJob(getDb(), jobId, model.ai);
    await vi.waitFor(() => expect(model.images).toHaveLength(2));

    failFirst(new AiFailure("REFUSED"));
    await expect(first).resolves.toEqual({ outcome: "skipped" });
    expect((await jobRow(getDb(), jobId)).status).toBe("running");

    finishSecond({ items: [extractedItem()] });
    await expect(second).resolves.toMatchObject({ outcome: "needs_review" });
  });

  it("stops picking up a job that keeps killing its runs", async () => {
    const { jobId, model } = await uploadPhoto();
    await getDb()
      .update(importJobs)
      .set({
        status: "running",
        runToken: sql`gen_random_uuid()`,
        leaseExpiresAt: sql`now() - interval '1 second'`,
        attempts: MAX_ATTEMPTS,
      })
      .where(eq(importJobs.id, jobId));

    await expect(runImportJob(getDb(), jobId, model.ai)).resolves.toEqual({ outcome: "skipped" });

    expect(model.images).toEqual([]);
    expect((await jobRow(getDb(), jobId)).attempts).toBe(MAX_ATTEMPTS);
  });

  it("lets a run that lost the job fail without touching the winner's state", async () => {
    const { jobId, model } = await uploadPhoto();
    let failSlowRun: (error: Error) => void = () => {};
    model.queue(() => new Promise((_resolve, reject) => (failSlowRun = reject)));
    const slowRun = runImportJob(getDb(), jobId, model.ai);
    await vi.waitFor(() => expect(model.images).toHaveLength(1));

    await expireLease(jobId);
    model.queue({ items: [extractedItem()] });
    await runImportJob(getDb(), jobId, model.ai);

    failSlowRun(new AiFailure("PROVIDER_UNAVAILABLE"));
    await expect(slowRun).resolves.toEqual({ outcome: "skipped" });
    expect((await jobRow(getDb(), jobId)).status).toBe("needs_review");
  });

  it("holds the rows to one result even if a write gets past the run check", async () => {
    const { jobId, shop, model } = await uploadPhoto();
    model.queue({ items: [extractedItem()] });
    await runImportJob(getDb(), jobId, model.ai);

    expect(
      await violatedConstraint(
        getDb()
          .insert(importRows)
          .values({ jobId, shopId: shop.id, position: 0, sourceRef: "Again" }),
      ),
    ).toBe("import_rows_job_id_position_unique");
  });

  it("does not claim a CSV import, which has nothing to read", async () => {
    const shop = await createShop(getDb());
    const { deps, model } = createImportHarness();
    const view = await createImport(
      getDb(),
      shop,
      { name: "prices.csv", bytes: Buffer.from("name,price\nCable,5\n") },
      deps,
    );
    await expect(runImportJob(getDb(), view.id, model.ai)).resolves.toEqual({ outcome: "skipped" });
  });

  it("ignores a job that does not exist", async () => {
    const { model } = createImportHarness();
    await expect(
      runImportJob(getDb(), "99999999-9999-4999-8999-999999999999", model.ai),
    ).resolves.toEqual({ outcome: "skipped" });
  });
});

describe("failures never publish data, and can be retried", () => {
  it.each(["MALFORMED_OUTPUT", "PROVIDER_UNAVAILABLE"] as const)(
    "queues the job again after %s, up to the attempt limit",
    async (code) => {
      const { jobId, model } = await uploadPhoto();
      model.queue(new AiFailure(code), new AiFailure(code), new AiFailure(code));

      await expect(runImportJob(getDb(), jobId, model.ai)).resolves.toEqual({ outcome: "retry", code });
      expect(await jobRow(getDb(), jobId)).toMatchObject({
        status: "queued",
        attempts: 1,
        error: code,
        runToken: null,
      });
      await expect(runImportJob(getDb(), jobId, model.ai)).resolves.toEqual({ outcome: "retry", code });
      await expect(runImportJob(getDb(), jobId, model.ai)).resolves.toEqual({ outcome: "failed", code });

      expect(await jobRow(getDb(), jobId)).toMatchObject({
        status: "failed",
        attempts: MAX_ATTEMPTS,
        error: code,
      });
      expect(model.images).toHaveLength(MAX_ATTEMPTS);
      expect(await rowsOf(getDb(), jobId)).toEqual([]);

      // The attempts are used up, so another delivery costs nothing.
      await expect(runImportJob(getDb(), jobId, model.ai)).resolves.toEqual({ outcome: "skipped" });
      expect(model.images).toHaveLength(MAX_ATTEMPTS);
    },
  );

  it("succeeds on a retry after a failure, storing one result", async () => {
    const { jobId, model } = await uploadPhoto();
    model.queue(new AiFailure("MALFORMED_OUTPUT"), { items: [extractedItem()] });
    await runImportJob(getDb(), jobId, model.ai);
    await expect(runImportJob(getDb(), jobId, model.ai)).resolves.toMatchObject({
      outcome: "needs_review",
    });
    expect(await rowsOf(getDb(), jobId)).toHaveLength(1);
    expect((await jobRow(getDb(), jobId)).error).toBeNull();
  });

  it("does not stop on a malformed reply through the real adapter", async () => {
    const { jobId } = await uploadPhoto();
    const fake = createFakeClaude();
    const ai = createClaudeAi({ ANTHROPIC_API_KEY: "test-key" }, { fetch: fake.fetch });
    fake.replyMessage({ blocks: [{ type: "text", text: "not json" }] });
    fake.replyStatus(529, "overloaded_error");
    fake.replyJson({ items: [extractedItem()] });

    await expect(runImportJob(getDb(), jobId, ai)).resolves.toMatchObject({ outcome: "retry" });
    await expect(runImportJob(getDb(), jobId, ai)).resolves.toMatchObject({ outcome: "retry" });
    expect(await rowsOf(getDb(), jobId)).toEqual([]);
    await expect(runImportJob(getDb(), jobId, ai)).resolves.toMatchObject({ outcome: "needs_review" });
    expect(await rowsOf(getDb(), jobId)).toHaveLength(1);
  });

  it.each(["SOURCE_REJECTED", "PROVIDER_REJECTED", "REFUSED", "TOO_LONG"] as const)(
    "does not pay for a repeat of %s",
    async (code) => {
      const { jobId, model } = await uploadPhoto();
      model.queue(new AiFailure(code));
      await expect(runImportJob(getDb(), jobId, model.ai)).resolves.toEqual({ outcome: "failed", code });
      expect(model.images).toHaveLength(1);
      expect(await jobRow(getDb(), jobId)).toMatchObject({ status: "failed", error: code });
    },
  );

  it("fails when the model finds nothing for sale", async () => {
    const { jobId, model } = await uploadPhoto();
    model.queue({ items: [] });
    await expect(runImportJob(getDb(), jobId, model.ai)).resolves.toEqual({
      outcome: "failed",
      code: "NOTHING_FOUND",
    });
  });

  it("fails when every entry is empty", async () => {
    const { jobId, model } = await uploadPhoto();
    model.queue({ items: [extractedItem({ name: null, priceText: null })] });
    await expect(runImportJob(getDb(), jobId, model.ai)).resolves.toMatchObject({
      code: "NOTHING_FOUND",
    });
  });

  it("refuses a list over the row limit, counting options as rows", async () => {
    const { jobId, model } = await uploadPhoto();
    model.queue({
      items: [
        extractedItem({
          variants: Array.from({ length: MAX_ROWS_PER_IMPORT + 1 }, (_, index) => ({
            label: `Option ${index}`,
            priceText: "5 €",
          })),
        }),
      ],
    });
    await expect(runImportJob(getDb(), jobId, model.ai)).resolves.toEqual({
      outcome: "failed",
      code: "TOO_LONG",
    });
    expect(await rowsOf(getDb(), jobId)).toEqual([]);
  });

  it("fails clearly when no model is configured", async () => {
    const { jobId } = await uploadPhoto();
    await expect(runImportJob(getDb(), jobId, undefined)).resolves.toEqual({
      outcome: "failed",
      code: "NOT_CONFIGURED",
    });
  });

  it("fails clearly when the photo has gone", async () => {
    const { jobId, model } = await uploadPhoto();
    await getDb().delete(importSources).where(eq(importSources.jobId, jobId));
    await expect(runImportJob(getDb(), jobId, model.ai)).resolves.toEqual({
      outcome: "failed",
      code: "SOURCE_EXPIRED",
    });
    expect(model.images).toEqual([]);
  });

  it("treats an unexpected exception as a retryable failure, logging only its name", async () => {
    const { jobId, model } = await uploadPhoto();
    model.queue(new TypeError("SECRET detail from a bug"));
    await expect(runImportJob(getDb(), jobId, model.ai)).resolves.toEqual({
      outcome: "retry",
      code: "INTERNAL",
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("SECRET");
  });

  it("lets a seller try again, with a fresh set of attempts", async () => {
    const { shop, jobId, model, deps, started } = await uploadPhoto();
    model.queue(
      new AiFailure("PROVIDER_UNAVAILABLE"),
      new AiFailure("PROVIDER_UNAVAILABLE"),
      new AiFailure("PROVIDER_UNAVAILABLE"),
    );
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await runImportJob(getDb(), jobId, model.ai);
    }
    const failed = await getImport(getDb(), shop, jobId);
    expect(failed.error).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });

    const retried = await retryImport(getDb(), shop, jobId, deps);
    expect(retried).toMatchObject({ status: "queued", error: null });
    expect(started.map((job) => job.id)).toEqual([jobId, jobId]);

    model.queue({ items: [extractedItem()] });
    await expect(runImportJob(getDb(), jobId, model.ai)).resolves.toMatchObject({
      outcome: "needs_review",
    });
    expect((await jobRow(getDb(), jobId)).attempts).toBe(1);
  });

  it("does not offer a retry that cannot work", async () => {
    const { shop, jobId, model, deps } = await uploadPhoto();
    model.queue(new AiFailure("SOURCE_REJECTED"));
    await runImportJob(getDb(), jobId, model.ai);
    expect((await getImport(getDb(), shop, jobId)).error?.retryable).toBe(false);
    await expect(retryImport(getDb(), shop, jobId, deps)).rejects.toMatchObject({
      code: "IMPORT_NOT_RETRYABLE",
    });
  });

  it("does not offer a retry once the photo has gone", async () => {
    const { shop, jobId, model, deps } = await uploadPhoto();
    model.queue(new AiFailure("REFUSED"));
    await runImportJob(getDb(), jobId, model.ai);
    expect((await getImport(getDb(), shop, jobId)).error?.retryable).toBe(true);

    await getDb().delete(importSources).where(eq(importSources.jobId, jobId));
    expect((await getImport(getDb(), shop, jobId)).error?.retryable).toBe(false);
    await expect(retryImport(getDb(), shop, jobId, deps)).rejects.toMatchObject({
      code: "IMPORT_NOT_RETRYABLE",
    });
  });

  it("refuses to retry a job that has not failed", async () => {
    const { shop, jobId, deps } = await uploadPhoto();
    await expect(retryImport(getDb(), shop, jobId, deps)).rejects.toMatchObject({
      code: "IMPORT_NOT_RETRYABLE",
    });
  });
});

describe("shops do not mix", () => {
  it("stores each job's rows under its own shop, from its own photo", async () => {
    const first = await uploadPhoto({}, JPEG);
    const second = await uploadPhoto({}, PNG);
    const model = createFakeAi();
    model.queue(
      { items: [extractedItem({ name: "First shop's glass" })] },
      { items: [extractedItem({ name: "Second shop's glass" })] },
    );

    await runImportJob(getDb(), first.jobId, model.ai);
    await runImportJob(getDb(), second.jobId, model.ai);

    expect(model.images).toEqual([JPEG, PNG]);
    expect(await rowsOf(getDb(), first.jobId)).toMatchObject([
      { shopId: first.shop.id, title: "First shop's glass" },
    ]);
    expect(await rowsOf(getDb(), second.jobId)).toMatchObject([
      { shopId: second.shop.id, title: "Second shop's glass" },
    ]);
  });

  it("does not let the database hold a row or a photo under another shop's job", async () => {
    const { jobId } = await uploadPhoto();
    const other = await createShop(getDb());

    expect(
      await violatedConstraint(
        getDb()
          .insert(importRows)
          .values({ jobId, shopId: other.id, position: 0, sourceRef: "Row 1" }),
      ),
    ).toBe("import_rows_job_shop_fk");

    const [otherJob] = await getDb()
      .insert(importJobs)
      .values({ shopId: other.id, sourceKind: "photo" })
      .returning();
    expect(
      await violatedConstraint(
        getDb().insert(importSources).values({
          jobId: otherJob.id,
          shopId: (await jobRow(getDb(), jobId)).shopId,
          mediaType: "image/jpeg",
          bytes: JPEG,
          expiresAt: new Date(),
        }),
      ),
    ).toBe("import_sources_job_shop_fk");
  });
});

describe("what the database itself refuses", () => {
  it("rejects a running job with no lease", async () => {
    const { jobId } = await uploadPhoto();
    expect(
      await violatedConstraint(
        getDb().update(importJobs).set({ status: "running" }).where(eq(importJobs.id, jobId)),
      ),
    ).toBe("import_jobs_running_holds_lease");
  });

  it("rejects a media type that is not one of the accepted images", async () => {
    const shop = await createShop(getDb());
    const [job] = await getDb()
      .insert(importJobs)
      .values({ shopId: shop.id, sourceKind: "photo" })
      .returning();
    expect(
      await violatedConstraint(
        getDb().insert(importSources).values({
          jobId: job.id,
          shopId: shop.id,
          mediaType: "image/svg+xml",
          bytes: JPEG,
          expiresAt: new Date(),
        }),
      ),
    ).toBe("import_sources_media_type");
  });
});
