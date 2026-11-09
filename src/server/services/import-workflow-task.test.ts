import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractPriceList,
  type ExtractPriceListDeps,
} from "../../../workflows/main";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const context = { metadata: { taskRunId: "trn-9" } };

function setup(overrides: Partial<ExtractPriceListDeps> = {}) {
  const close = vi.fn().mockResolvedValue(undefined);
  const db = {} as never;
  const runImportJob = vi
    .fn()
    .mockResolvedValue({ outcome: "needs_review", rowCount: 3 });
  const deps: ExtractPriceListDeps = {
    createDb: vi.fn(() => ({ db, close })) as never,
    runImportJob,
    createImportAi: vi.fn(() => undefined),
    env: {
      DATABASE_URL: "postgres://u:supersecret@h/db",
      ANTHROPIC_API_KEY: "sk-secret",
    },
    ...overrides,
  };
  return { deps, close, runImportJob };
}

function logged() {
  return JSON.stringify([
    ...vi.mocked(console.info).mock.calls,
    ...vi.mocked(console.error).mock.calls,
  ]);
}

afterEach(() => vi.restoreAllMocks());

describe("extractPriceList", () => {
  it.each([undefined, 42, "", "not-a-uuid", `${JOB_ID}; drop`])(
    "returns a failure, not a throw, for input %j",
    async (input) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { deps, runImportJob } = setup();
      await expect(extractPriceList(context, input, deps)).resolves.toEqual({
        outcome: "failed",
        code: "INVALID_INPUT",
      });
      expect(runImportJob).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalled();
    },
  );

  it("throws when DATABASE_URL is missing", async () => {
    const { deps, runImportJob } = setup({ env: {} });
    await expect(extractPriceList(context, JOB_ID, deps)).rejects.toThrow(
      "DATABASE_URL",
    );
    expect(runImportJob).not.toHaveBeenCalled();
  });

  it("returns the result and closes the database", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, close, runImportJob } = setup();
    await expect(extractPriceList(context, JOB_ID, deps)).resolves.toEqual({
      outcome: "needs_review",
      rowCount: 3,
    });
    expect(runImportJob).toHaveBeenCalledWith(
      expect.anything(),
      JOB_ID,
      undefined,
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(console.info).toHaveBeenCalledWith("Import task finished", {
      jobId: JOB_ID,
      taskRunId: "trn-9",
      outcome: "needs_review",
    });
    expect(logged()).not.toMatch(/supersecret|sk-secret/);
  });

  it("throws on retry so Render retries, and closes the database", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, close } = setup({
      runImportJob: vi
        .fn()
        .mockResolvedValue({ outcome: "retry", code: "INTERNAL" }),
    });
    await expect(extractPriceList(context, JOB_ID, deps)).rejects.toThrow(
      "INTERNAL",
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the database when the run throws", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, close } = setup({
      runImportJob: vi
        .fn()
        .mockRejectedValue(new Error("db password supersecret")),
    });
    await expect(extractPriceList(context, JOB_ID, deps)).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
    expect(logged()).not.toMatch(/supersecret/);
  });
});
