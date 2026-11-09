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
      const afterHookSnapshot = afterHook[Math.min(deployListNumber++, afterHook.length - 1)];
      const deploys = deployListNumber === 1 ? [previous] : afterHookSnapshot;
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
    expect(fake.calls[0].url).toContain("/v1/services/srv-dbm8a6e1egvs73bl8d90/deploys?limit=100");
    expect(fake.calls.some((call) => call.method === "POST" && call.url.includes("ref=" + commit))).toBe(true);
    expect(fake.logs.at(-1)).toContain("health and readiness checks passed");
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
