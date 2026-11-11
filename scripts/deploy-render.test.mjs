import { describe, expect, it } from "vitest";
import { deployAndVerify } from "./deploy-render.mjs";

const commit = "a".repeat(40);
const env = {
  RENDER_DEPLOY_HOOK_URL: "https://api.render.com/deploy/srv-dbm8a6e1egvs73bl8d90?key=hook-secret",
  RENDER_API_KEY: "render-secret",
  GITHUB_SHA: commit,
  PUBLIC_BASE_URL: "https://agentshelf-e5bk.onrender.com",
};
const previous = { id: "deploy-old", status: "live", trigger: "deploy_hook", commit: { id: commit } };
const current = (status) => ({ id: "deploy-new", status, trigger: "deploy_hook", commit: { id: commit } });

function response(status, body = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function harness({ afterHook = [[previous, current("live")]], hookStatus = 202, hookDeployId, apiStatus = 200 } = {}) {
  const calls = [];
  const logs = [];
  let deployListNumber = 0;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url: url.href, method: options.method ?? "GET", headers: options.headers });
    if (url.hostname === "api.render.com" && url.pathname.endsWith("/deploys") && options.method !== "POST") {
      if (apiStatus !== 200) return response(apiStatus, { error: "upstream echoes render-secret and hook-secret" });
      const listNumber = deployListNumber++;
      const deploys = listNumber === 0
        ? [previous]
        : afterHook[Math.min(listNumber - 1, afterHook.length - 1)];
      return response(200, deploys.map((deploy) => ({ deploy, cursor: "next" })));
    }
    if (url.pathname === "/deploy/srv-dbm8a6e1egvs73bl8d90") return response(hookStatus, hookDeployId ? { id: hookDeployId } : {});
    if (url.hostname === "agentshelf-e5bk.onrender.com" && url.pathname === "/api/health") return response(200, { commit });
    if (url.hostname === "agentshelf-e5bk.onrender.com") return response(200, {});
    throw new Error("Unexpected request");
  };
  let clock = 0;
  return {
    calls,
    logs,
    fetchImpl,
    logger: { log: (message) => logs.push(message) },
    now: () => clock,
    sleepImpl: async (ms) => { clock += ms; },
  };
}

describe("deployAndVerify", () => {
  it("requires Render API credentials before requesting a deployment", async () => {
    const fake = harness();
    const missing = { ...env };
    delete missing.RENDER_API_KEY;
    await expect(deployAndVerify({ env: missing, fetchImpl: fake.fetchImpl, logger: fake.logger }))
      .rejects.toThrow("Missing deploy configuration.");
    expect(fake.calls).toHaveLength(0);
  });

  it("waits for a new deploy ID after the baseline, including a 202 hook response", async () => {
    const fake = harness({ afterHook: [[previous, current("build_in_progress")], [previous, current("live")]] });
    const result = await deployAndVerify({ ...fake, env });
    expect(result).toEqual({ commit });
    expect(fake.calls.filter((call) => call.url.includes("/deploys"))).toHaveLength(3);
    expect(fake.now()).toBeGreaterThanOrEqual(10_000);
    expect(fake.calls[0].url).toContain("/v1/services/srv-dbm8a6e1egvs73bl8d90/deploys?limit=100");
    expect(fake.calls.some((call) => call.method === "POST" && call.url.includes("ref=" + commit))).toBe(true);
    expect(fake.logs.at(-2)).toContain("health and readiness checks passed");
  });

  it("verifies the exact deploy ID returned by a 200 hook response", async () => {
    const fake = harness({
      hookStatus: 200,
      hookDeployId: "deploy-new",
      afterHook: [[previous, current("live")]],
    });
    await expect(deployAndVerify({ ...fake, env })).resolves.toEqual({ commit });
    expect(fake.logs.join(" ")).not.toContain("deploy-new");
  });

  it("does not mistake an already-live identical SHA for the newly requested deployment", async () => {
    const fake = harness({ afterHook: [[previous]] });
    await expect(deployAndVerify({ ...fake, env })).rejects.toThrow("did not verify a new live deploy");
    expect(fake.calls.some((call) => call.url.includes("/api/health"))).toBe(false);
  });

  it("binds a 200 hook response to its returned deploy ID", async () => {
    const fake = harness({
      hookStatus: 200,
      hookDeployId: "deploy-new",
      afterHook: [[previous, { ...current("live"), id: "different-new-deploy" }]],
    });
    await expect(deployAndVerify({ ...fake, env })).rejects.toThrow("did not verify a new live deploy");
    expect(fake.calls.some((call) => call.url.includes("/api/health"))).toBe(false);
  });

  it("rejects credential-bearing public URLs before making requests", async () => {
    const fake = harness();
    const invalid = { ...env, PUBLIC_BASE_URL: "https://user:pass@agentshelf-e5bk.onrender.com" };
    await expect(deployAndVerify({ ...fake, env: invalid })).rejects.toThrow("Public service URL does not match");
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects a failed new deploy without public health checks", async () => {
    const fake = harness({ afterHook: [[previous, current("build_failed")]] });
    await expect(deployAndVerify({ ...fake, env })).rejects.toThrow("new Render deploy failed");
    expect(fake.calls.some((call) => call.url.includes("/api/health"))).toBe(false);
  });

  it("does not leak Render credentials or upstream response content", async () => {
    const fake = harness({ apiStatus: 500 });
    let error;
    try {
      await deployAndVerify({ ...fake, env });
    } catch (caught) {
      error = caught;
    }
    expect(error?.message).toBe("Render API request failed (HTTP 500).");
    expect(error?.message).not.toContain("render-secret");
    expect(error?.message).not.toContain("hook-secret");
    expect(fake.logs.join(" ")).not.toContain("render-secret");
    expect(fake.logs.join(" ")).not.toContain("hook-secret");
  });
});

describe("deployAndVerify workflow release", () => {
  const wfEnv = { ...env, RENDER_WORKFLOW_ID: "wfl-test123" };
  const fresh = () => new Date().toISOString();
  const version = (status, extra = {}) => ({ id: "wfv-new", workflowId: "wfl-test123", name: "v", createdAt: fresh(), status, ...extra });
  const task = { id: "tsk-1", name: "extractPriceList", workflowVersionId: "wfv-new" };
  const revisionTask = { id: "tsk-revision", name: `revision_${commit}`, workflowVersionId: "wfv-new" };

  function wfHarness({ statuses = ["building", "ready"], tasks = [{ task }, { task: revisionTask }], postStatus = 202, webOk = true, wrapped = true, concurrentVersion = false, emptyBaseline = false } = {}) {
    const base = harness({ afterHook: [[previous, current(webOk ? "live" : "build_failed")]] });
    const wfCalls = [];
    let polls = 0;
    const inner = base.fetchImpl;
    let releaseRequested = false;
    const fetchImpl = async (input, options = {}) => {
      const url = new URL(input);
      const method = options.method ?? "GET";
      const isWf = url.hostname === "api.render.com" &&
        (url.pathname.startsWith("/v1/workflow") || url.pathname.startsWith("/v1/tasks"));
      if (!isWf) return inner(input, options);
      wfCalls.push({ method, url: url.href, body: options.body });
      if (url.pathname === "/v1/workflowversions" && method === "POST") {
        releaseRequested = true;
        return new Response(null, { status: postStatus });
      }
      if (url.pathname === "/v1/workflowversions") {
        const old = version("ready", { id: "wfv-old", createdAt: "2020-01-01T00:00:00Z" });
        const mine = version(statuses[0]);
        const concurrent = version("ready", { id: "wfv-concurrent", name: "dashboard" });
        if (!releaseRequested && emptyBaseline) return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
        const previous = emptyBaseline ? [] : [old];
        const found = releaseRequested ? [mine, ...(concurrentVersion ? [concurrent] : []), ...previous] : previous;
        return response(200, found.map((v) => (wrapped ? { workflowVersion: v } : v)));
      }
      if (url.pathname === "/v1/workflowversions/wfv-new") {
        return response(200, version(statuses[Math.min(++polls, statuses.length - 1)]));
      }
      if (url.pathname === "/v1/tasks") {
        if (url.searchParams.get("workflowVersionId") !== "wfv-new") throw new Error("Task lookup was not scoped to the selected version");
        const cursor = url.searchParams.get("cursor");
        if (tasks.length > 100) {
          const page = cursor === "next" ? tasks.slice(100) : tasks.slice(0, 100);
          const wrappedPage = page.map((entry) => ({ ...entry }));
          if (cursor !== "next" && wrappedPage.length) wrappedPage.at(-1).cursor = "next";
          return response(200, wrappedPage);
        }
        return response(200, tasks);
      }
      if (url.pathname === "/v1/workflows/wfl-test123") return response(200, { id: "wfl-test123", slug: "agentshelf-import-x" });
      throw new Error("Unexpected request " + url.href);
    };
    return { ...base, fetchImpl, wfCalls };
  }

  it("logs and makes no workflow requests when unconfigured", async () => {
    const fake = wfHarness();
    await expect(deployAndVerify({ ...fake, env })).resolves.toEqual({ commit });
    expect(fake.wfCalls).toHaveLength(0);
    expect(fake.logs).toContain("Render Workflow not configured; no workflow release requested.");
    expect(fake.calls.filter((c) => c.url.includes("/deploy/") && c.method === "POST")).toHaveLength(1);
  });

  it("releases the requested commit and verifies task registration for the selected new version", async () => {
    const fake = wfHarness();
    const result = await deployAndVerify({ ...fake, env: wfEnv });
    expect(result.workflow).toEqual({ versionId: "wfv-new", status: "ready", slug: "agentshelf-import-x", taskId: "tsk-1", revisionTaskId: "tsk-revision" });
    const post = fake.wfCalls.find((c) => c.method === "POST");
    expect(JSON.parse(post.body)).toEqual({ workflowId: "wfl-test123", commit });
    expect(fake.wfCalls.some((c) => c.url.includes("workflowID=wfl-test123"))).toBe(true);
    expect(fake.wfCalls.some((c) => c.url.includes("workflowVersionId=wfv-new"))).toBe(true);
    expect(fake.calls.filter((c) => c.url.includes("/deploy/") && c.method === "POST")).toHaveLength(1);
    expect(fake.logs.at(-1)).toContain(`revision marker revision_${commit} are registered`);
    const output = fake.logs.join(" ");
    for (const value of ["render-secret", "hook-secret"]) expect(output).not.toContain(value);
  });

  it("accepts a 201 release response", async () => {
    const fake = wfHarness({ postStatus: 201 });
    await expect(deployAndVerify({ ...fake, env: wfEnv })).resolves.toMatchObject({ workflow: { versionId: "wfv-new", status: "ready" } });
  });

  it("treats a null version list as no versions for a new workflow's first release", async () => {
    const fake = wfHarness({ emptyBaseline: true });
    await expect(deployAndVerify({ ...fake, env: wfEnv })).resolves.toMatchObject({ workflow: { versionId: "wfv-new", status: "ready" } });
  });

  it("accepts unwrapped version and task objects", async () => {
    const fake = wfHarness({ wrapped: false, tasks: [task, revisionTask] });
    await expect(deployAndVerify({ ...fake, env: wfEnv })).resolves.toMatchObject({ workflow: { taskId: "tsk-1", revisionTaskId: "tsk-revision" } });
  });

  it("fails when registration fails", async () => {
    const fake = wfHarness({ statuses: ["registering", "registration_failed"] });
    await expect(deployAndVerify({ ...fake, env: wfEnv })).rejects.toThrow("registration_failed");
  });

  it("does not select a preexisting version for the new release", async () => {
    const fake = wfHarness();
    // The old version is present in the pre-release baseline; only newly-created IDs are eligible.
    await expect(deployAndVerify({ ...fake, env: wfEnv })).resolves.toMatchObject({ workflow: { versionId: "wfv-new" } });
    expect(fake.wfCalls.filter((c) => c.url.includes("/workflowversions/wfv-old"))).toHaveLength(0);
  });

  it("fails closed if more than one new version appears during the CI release", async () => {
    const fake = wfHarness({ concurrentVersion: true });
    await expect(deployAndVerify({ ...fake, env: wfEnv })).rejects.toThrow("Multiple Render Workflow versions appeared during release");
  });

  it("fails when the task is missing from the ready version", async () => {
    const other = { ...task, name: "other" };
    const fake = wfHarness({ statuses: ["ready"], tasks: [{ task: other }, { task: revisionTask }] });
    await expect(deployAndVerify({ ...fake, env: wfEnv })).rejects.toThrow("does not register both extractPriceList");
  });

  it("fails if the revision marker for the requested SHA is missing", async () => {
    const fake = wfHarness({ statuses: ["ready"], tasks: [{ task }, { task: { ...revisionTask, name: `revision_${"b".repeat(40)}` } }] });
    await expect(deployAndVerify({ ...fake, env: wfEnv })).rejects.toThrow(`does not register both extractPriceList and revision_${commit}`);
  });

  it("does not accept a requested-SHA marker registered only for an older version", async () => {
    const fake = wfHarness({ statuses: ["ready"], tasks: [{ task }, { task: { ...revisionTask, workflowVersionId: "wfv-old" } }] });
    await expect(deployAndVerify({ ...fake, env: wfEnv })).rejects.toThrow(`does not register both extractPriceList and revision_${commit}`);
  });

  it("paginates the selected version's task registrations", async () => {
    const noise = Array.from({ length: 101 }, (_, index) => ({ task: {
      id: `tsk-noise-${index}`, name: `noise-${index}`, workflowVersionId: "wfv-new",
    } }));
    const fake = wfHarness({ statuses: ["ready"], tasks: [...noise, { task }, { task: revisionTask }] });
    await expect(deployAndVerify({ ...fake, env: wfEnv })).resolves.toMatchObject({
      workflow: { taskId: "tsk-1", revisionTaskId: "tsk-revision" },
    });
    expect(fake.wfCalls.filter((call) => call.url.includes("/v1/tasks?")).map((call) => new URL(call.url).searchParams.get("cursor")))
      .toEqual([null, "next"]);
  });

  it("fails on timeout", async () => {
    const fake = wfHarness({ statuses: ["building"] });
    await expect(deployAndVerify({ ...fake, env: wfEnv })).rejects.toThrow("did not become ready");
  });

  it("fails when the release request is rejected", async () => {
    const fake = wfHarness({ postStatus: 500 });
    await expect(deployAndVerify({ ...fake, env: wfEnv })).rejects.toThrow("HTTP 500");
  });

  it("makes no workflow request when the web deploy fails", async () => {
    const fake = wfHarness({ webOk: false });
    await expect(deployAndVerify({ ...fake, env: wfEnv })).rejects.toThrow("new Render deploy failed");
    expect(fake.wfCalls).toHaveLength(0);
  });

  it("rejects an invalid workflow ID before any request", async () => {
    const fake = wfHarness();
    await expect(deployAndVerify({ ...fake, env: { ...wfEnv, RENDER_WORKFLOW_ID: "a/b" } })).rejects.toThrow("RENDER_WORKFLOW_ID is invalid.");
    expect(fake.calls).toHaveLength(0);
  });
});
