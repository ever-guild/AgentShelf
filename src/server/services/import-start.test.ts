import { afterEach, describe, expect, it, vi } from "vitest";

import type { Db } from "../db/client";
import {
  configuredWorkflowSlug,
  importRunMode,
  renderWorkflowRunner,
  workflowRunner,
} from "./import-start";

const JOB = {
  id: "11111111-1111-4111-8111-111111111111",
  updatedAt: new Date(1_700_000_000_000),
};

function fakeDb() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { db: { update } as unknown as Db, set, where };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("importRunMode", () => {
  it.each([
    [{}, { mode: "web-process" }],
    [{ RENDER_API_KEY: "k" }, { mode: "web-process" }],
    [
      { RENDER_WORKFLOW_SLUG: "w" },
      { mode: "web-process", reason: "RENDER_API_KEY_MISSING" },
    ],
    [
      { RENDER_WORKFLOW_SLUG: "w", RENDER_USE_LOCAL_DEV: "false" },
      { mode: "web-process", reason: "RENDER_API_KEY_MISSING" },
    ],
    [
      { RENDER_WORKFLOW_SLUG: "w", RENDER_LOCAL_DEV_URL: "  " },
      { mode: "web-process", reason: "RENDER_API_KEY_MISSING" },
    ],
    [
      { RENDER_WORKFLOW_SLUG: "w", RENDER_API_KEY: "k" },
      { mode: "render-workflow", slug: "w" },
    ],
    [
      { RENDER_WORKFLOW_SLUG: "w", RENDER_USE_LOCAL_DEV: "true" },
      { mode: "render-workflow", slug: "w" },
    ],
    [
      {
        RENDER_WORKFLOW_SLUG: "w",
        RENDER_LOCAL_DEV_URL: "http://localhost:8120",
      },
      { mode: "render-workflow", slug: "w" },
    ],
  ])("%j", (env, expected) => {
    expect(importRunMode(env)).toEqual(expected);
    expect(configuredWorkflowSlug(env)).toBe(
      (expected as { slug?: string }).slug,
    );
  });
});

describe("defaultImportDeps", () => {
  it("warns once, with a reason and no values, when the workflow is unreachable", async () => {
    vi.stubEnv("RENDER_WORKFLOW_SLUG", "secret-slug");
    vi.stubEnv("RENDER_API_KEY", "");
    vi.stubEnv("RENDER_USE_LOCAL_DEV", "");
    vi.stubEnv("RENDER_LOCAL_DEV_URL", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { defaultImportDeps } = await import("./import-start");
    defaultImportDeps();
    defaultImportDeps();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Render Workflow configured but not reachable; photo imports run in the web process",
      { reason: "RENDER_API_KEY_MISSING" },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-slug");
  });

  it("does not warn when no workflow is configured", async () => {
    vi.stubEnv("RENDER_WORKFLOW_SLUG", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { defaultImportDeps } = await import("./import-start");
    defaultImportDeps();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("workflowRunner", () => {
  it("starts the task with the job ID only, records the run and logs it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const startTask = vi.fn().mockResolvedValue({ taskRunId: "trn-1" });
    const { db, set } = fakeDb();
    await workflowRunner({ startTask }, "wf")(db, JOB);
    expect(startTask).toHaveBeenCalledWith("wf/extractPriceList", [JOB.id], {
      idempotencyKey: `${JOB.id}:${JOB.updatedAt.getTime()}`,
      signal: expect.any(AbortSignal),
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ workflowRunId: "trn-1" }),
    );
    expect(info).toHaveBeenCalledWith("Import run started", {
      jobId: JOB.id,
      runner: "render-workflow",
      taskRunId: "trn-1",
    });
  });

  it("logs the status and error name of a failed start, and rethrows", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    class ClientError extends Error {
      statusCode = 401;
      constructor() {
        super("token rnd_secret rejected");
        this.name = "ClientError";
      }
    }
    const failure = new ClientError();
    const startTask = vi.fn().mockRejectedValue(failure);
    const { db, set } = fakeDb();
    await expect(workflowRunner({ startTask }, "wf")(db, JOB)).rejects.toBe(
      failure,
    );
    expect(set).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("Render Workflow start failed", {
      jobId: JOB.id,
      status: 401,
      errorName: "ClientError",
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain("rnd_secret");
  });

  it("omits the status when the error has none", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const startTask = vi.fn().mockRejectedValue(new TypeError("boom"));
    await expect(
      workflowRunner({ startTask }, "wf")(fakeDb().db, JOB),
    ).rejects.toThrow();
    expect(error).toHaveBeenCalledWith("Render Workflow start failed", {
      jobId: JOB.id,
      errorName: "TypeError",
    });
  });
});

describe("renderWorkflowRunner", () => {
  it("does not keep a failed client, so the next start tries again", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const startTask = vi.fn().mockResolvedValue({ taskRunId: "trn-2" });
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error("no token"))
      .mockResolvedValue({ startTask });
    const run = renderWorkflowRunner("wf", factory);
    const { db } = fakeDb();
    await expect(run(db, JOB)).rejects.toThrow("no token");
    await run(db, JOB);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(startTask).toHaveBeenCalledTimes(1);
    await run(db, JOB);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
