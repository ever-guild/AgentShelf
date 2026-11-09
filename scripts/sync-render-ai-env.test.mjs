import { describe, expect, it } from "vitest";
import { syncRenderAiEnv } from "./sync-render-ai-env.mjs";

const secret = "test-secret-never-log-this";
const desired = {
  AGENT_SHELF_AI_PROVIDER: "openai",
  AGENT_SHELF_AI_PROVIDER_BASE_URL: "https://api.openai.com/v1",
  AGENT_SHELF_AI_PROVIDER_API_KEY: secret,
};
const apiKey = "render-api-test-token";

function harness(initial = {}) {
  const values = new Map(Object.entries(initial));
  const calls = [];
  const logs = [];
  let failPutFor;
  let failGetFor;
  let wrongReadbackFor;
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    const key = decodeURIComponent(url.pathname.split("/").at(-1));
    calls.push({ method: options.method, key, url: url.href, options });
    if (options.method === "GET" && key === failGetFor) {
      return new Response("secret echoed by upstream: " + secret, { status: 503 });
    }
    if (options.method === "GET") {
      if (!values.has(key)) return new Response("not found", { status: 404 });
      return Response.json({ key, value: key === wrongReadbackFor ? "wrong-value" : values.get(key) });
    }
    if (options.method === "PUT") {
      if (key === failPutFor) return new Response("secret echoed by upstream: " + secret, { status: 500 });
      values.set(key, JSON.parse(options.body).value);
      return Response.json({ key, value: values.get(key) });
    }
    throw new Error("unexpected method");
  };
  return {
    values,
    calls,
    logs,
    fetchImpl,
    setFailPutFor: (key) => { failPutFor = key; },
    setFailGetFor: (key) => { failGetFor = key; },
    setWrongReadbackFor: (key) => { wrongReadbackFor = key; },
    logger: { log: (message) => logs.push(message) },
  };
}

describe("syncRenderAiEnv", () => {
  it("fails preflight before any Render request if one GitHub setting is missing", async () => {
    const fake = harness();
    const missingKey = { ...desired };
    delete missingKey.AGENT_SHELF_AI_PROVIDER_API_KEY;
    await expect(syncRenderAiEnv({ env: missingKey, apiKey, fetchImpl: fake.fetchImpl, logger: fake.logger }))
      .rejects.toThrow("AGENT_SHELF_AI_PROVIDER_API_KEY");
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects credential-bearing or noncanonical provider URLs before Render requests", async () => {
    const fake = harness();
    const invalid = { ...desired, AGENT_SHELF_AI_PROVIDER_BASE_URL: "https://user:pass@api.openai.com/v1" };
    await expect(syncRenderAiEnv({ env: invalid, apiKey, fetchImpl: fake.fetchImpl, logger: fake.logger }))
      .rejects.toThrow("must be https://api.openai.com/v1");
    expect(fake.calls).toHaveLength(0);
  });

  it("updates only the three owned keys and preserves unrelated service settings", async () => {
    const fake = harness({ DATABASE_URL: "db-url", APP_SIGNING_SECRET: "signing", ...desired, AGENT_SHELF_AI_PROVIDER_API_KEY: "old-key" });
    await syncRenderAiEnv({ env: desired, apiKey, fetchImpl: fake.fetchImpl, logger: fake.logger });
    expect([...fake.values.entries()]).toEqual(expect.arrayContaining([
      ["DATABASE_URL", "db-url"],
      ["APP_SIGNING_SECRET", "signing"],
      ...Object.entries(desired),
    ]));
    expect(fake.calls.filter((call) => call.method === "PUT").map((call) => call.key))
      .toEqual(["AGENT_SHELF_AI_PROVIDER_API_KEY"]);
    expect(fake.calls.filter((call) => call.method === "PUT").every((call) => call.url.startsWith("https://api.render.com/v1/services/srv-dbm8a6e1egvs73bl8d90/env-vars/"))).toBe(true);
    expect(fake.calls.every((call) => call.options.redirect === "error")).toBe(true);
  });

  it("does not write when already synchronized", async () => {
    const fake = harness({ ...desired });
    const result = await syncRenderAiEnv({ env: desired, apiKey, fetchImpl: fake.fetchImpl, logger: fake.logger });
    expect(result.changed).toEqual([]);
    expect(fake.calls.some((call) => call.method === "PUT")).toBe(false);
    expect(fake.logs).toEqual(["Render AI environment already matches GitHub Environment; no updates made."]);
  });

  it("does not begin writes if any preflight read fails", async () => {
    const fake = harness({ ...desired });
    fake.setFailGetFor("AGENT_SHELF_AI_PROVIDER_BASE_URL");
    await expect(syncRenderAiEnv({ env: desired, apiKey, fetchImpl: fake.fetchImpl, logger: fake.logger }))
      .rejects.toThrow("AGENT_SHELF_AI_PROVIDER_BASE_URL");
    expect(fake.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("stops on update failure and never reports success", async () => {
    const fake = harness({ ...desired, AGENT_SHELF_AI_PROVIDER_API_KEY: "old-key" });
    fake.setFailPutFor("AGENT_SHELF_AI_PROVIDER_API_KEY");
    await expect(syncRenderAiEnv({ env: desired, apiKey, fetchImpl: fake.fetchImpl, logger: fake.logger }))
      .rejects.toThrow("Render update failed for AGENT_SHELF_AI_PROVIDER_API_KEY (HTTP 500).");
    expect(fake.logs).toEqual([]);
    expect(fake.calls.some((call) => call.method === "PUT" && call.key === "AGENT_SHELF_AI_PROVIDER_API_KEY")).toBe(true);
  });

  it("fails readback on mismatch without printing secret values", async () => {
    const fake = harness({ ...desired });
    fake.setWrongReadbackFor("AGENT_SHELF_AI_PROVIDER_API_KEY");
    let error;
    try {
      await syncRenderAiEnv({ env: desired, apiKey, fetchImpl: fake.fetchImpl, logger: fake.logger });
    } catch (caught) {
      error = caught;
    }
    expect(error?.message).toContain("AGENT_SHELF_AI_PROVIDER_API_KEY");
    expect(error?.message).not.toContain(secret);
    expect(fake.logs.join(" ")).not.toContain(secret);
  });

  it("redacts upstream response bodies and fetch exception messages", async () => {
    const fake = harness({ ...desired });
    fake.setFailGetFor("AGENT_SHELF_AI_PROVIDER");
    let error;
    try {
      await syncRenderAiEnv({ env: desired, apiKey, fetchImpl: fake.fetchImpl, logger: fake.logger });
    } catch (caught) {
      error = caught;
    }
    expect(error?.message).toBe("Render read failed for AGENT_SHELF_AI_PROVIDER (HTTP 503).");
    expect(error?.message).not.toContain(secret);
    expect(fake.logs.join(" ")).not.toContain(secret);
  });
});
