import { pathToFileURL } from "node:url";

const SERVICE_ID = "srv-dbm8a6e1egvs73bl8d90";
const API_ORIGIN = "https://api.render.com";
const MAPPINGS = [
  { source: "AGENT_SHELF_AI_PROVIDER", target: "AGENT_SHELF_AI_PROVIDER" },
  { source: "AGENT_SHELF_AI_PROVIDER_BASE_URL", target: "AGENT_SHELF_AI_PROVIDER_BASE_URL" },
  { source: "AGENT_SHELF_AI_PROVIDER_API_KEY", target: "AGENT_SHELF_AI_PROVIDER_API_KEY" },
  { source: "AG_STUDIO", target: "AG_STUDIO" },
];
const KEYS = MAPPINGS.map(({ target }) => target);
// Only these keys are ever written to the workflow; AG_STUDIO and RENDER_API_KEY never are.
const WORKFLOW_KEYS = KEYS.filter((key) => key.startsWith("AGENT_SHELF_AI_PROVIDER"));
const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9-]{3,64}$/;
const WEB_TARGET = { label: "web service", base: `/v1/services/${SERVICE_ID}/env-vars` };
// A workflow's env vars use the service env-var endpoint with the workflow ID; checked against the live
// workflow on 11 November 2026 (the build-source endpoint returns 404 for a workflow ID).
const workflowTarget = (workflowId) => ({ label: "workflow", base: `/v1/services/${workflowId}/env-vars` });

function readAndValidateConfig(env) {
  const config = Object.fromEntries(MAPPINGS.map(({ source, target }) => [target, env[source]]));
  const missing = MAPPINGS
    .filter(({ target }) => typeof config[target] !== "string" || config[target].trim() === "")
    .map(({ source }) => source);
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(", ")}.`);
  if (config.AGENT_SHELF_AI_PROVIDER !== "openai") {
    throw new Error("AGENT_SHELF_AI_PROVIDER must be openai.");
  }
  let baseUrl;
  try {
    baseUrl = new URL(config.AGENT_SHELF_AI_PROVIDER_BASE_URL);
  } catch {
    throw new Error("AGENT_SHELF_AI_PROVIDER_BASE_URL must be a valid HTTPS URL.");
  }
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.hostname !== "api.openai.com" ||
    baseUrl.port !== "" ||
    baseUrl.username !== "" ||
    baseUrl.password !== "" ||
    baseUrl.pathname !== "/v1" ||
    baseUrl.search !== "" ||
    baseUrl.hash !== ""
  ) {
    throw new Error("AGENT_SHELF_AI_PROVIDER_BASE_URL must be https://api.openai.com/v1.");
  }
  return config;
}

function valueFromPayload(payload, key) {
  const item = payload?.envVar ?? payload;
  if (item?.key !== key || typeof item.value !== "string") {
    throw new Error(`Render returned an invalid response for ${key}.`);
  }
  return item.value;
}

async function getCurrentValue(fetchImpl, apiKey, key, target = WEB_TARGET) {
  const url = new URL(`${target.base}/${encodeURIComponent(key)}`, API_ORIGIN);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
  } catch {
    throw new Error(`Render read request failed for ${key}.`);
  }
  if (response.status === 404) return undefined;
  if (response.status !== 200) throw new Error(`Render read failed for ${key} (HTTP ${response.status}).`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Render returned invalid JSON for ${key}.`);
  }
  return valueFromPayload(payload, key);
}

async function putValue(fetchImpl, apiKey, key, value, target = WEB_TARGET) {
  const url = new URL(`${target.base}/${encodeURIComponent(key)}`, API_ORIGIN);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "PUT",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value }),
    });
  } catch {
    throw new Error(`Render update failed for ${key}.`);
  }
  if (response.status !== 200) throw new Error(`Render update failed for ${key} (HTTP ${response.status}).`);
}

export async function syncRenderAiEnv({ env, apiKey, fetchImpl = fetch, logger = console }) {
  const desired = readAndValidateConfig(env);
  const channel3ApiKey = env.CHANNEL3_API_KEY;
  const hasChannel3ApiKey = typeof channel3ApiKey === "string" && channel3ApiKey.trim() !== "";
  if (hasChannel3ApiKey) desired.CHANNEL3_API_KEY = channel3ApiKey;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new Error("Missing required configuration: RENDER_API_KEY.");
  }
  const rawWorkflowId = env.RENDER_WORKFLOW_ID;
  const workflowId = typeof rawWorkflowId === "string" && rawWorkflowId.trim() !== "" ? rawWorkflowId.trim() : undefined;
  if (workflowId !== undefined && !WORKFLOW_ID_PATTERN.test(workflowId)) {
    throw new Error("RENDER_WORKFLOW_ID is invalid.");
  }
  const webKeys = hasChannel3ApiKey ? [...KEYS, "CHANNEL3_API_KEY"] : KEYS;
  const targets = [{ ...WEB_TARGET, keys: webKeys }];
  if (workflowId !== undefined) targets.push({ ...workflowTarget(workflowId), keys: WORKFLOW_KEYS });

  // Read all managed values of every target before writing so a read failure never leaves a partial sync.
  for (const target of targets) {
    target.current = {};
    for (const key of target.keys) target.current[key] = await getCurrentValue(fetchImpl, apiKey, key, target);
    target.changed = target.keys.filter((key) => target.current[key] !== desired[key]);
  }
  for (const target of targets) {
    for (const key of target.changed) await putValue(fetchImpl, apiKey, key, desired[key], target);
  }
  for (const target of targets) {
    const mismatches = [];
    for (const key of target.keys) {
      if ((await getCurrentValue(fetchImpl, apiKey, key, target)) !== desired[key]) mismatches.push(key);
    }
    if (mismatches.length) {
      const where = target.label === "workflow" ? " (workflow)" : "";
      throw new Error(`Render readback did not match GitHub Environment for: ${mismatches.join(", ")}${where}.`);
    }
  }

  const [web, workflow] = targets;
  if (web.changed.length === 0) logger.log("Render AI environment already matches GitHub Environment; no updates made.");
  else logger.log(`Render AI environment synchronized: ${web.changed.join(", ")}.`);
  if (workflow) {
    if (workflow.changed.length === 0) logger.log("Render workflow AI environment already matches GitHub Environment; no updates made.");
    else logger.log(`Render workflow AI environment synchronized: ${workflow.changed.join(", ")}.`);
  } else {
    logger.log("Render Workflow not configured; workflow settings not synced.");
  }
  if (!hasChannel3ApiKey) logger.log("Channel3 API key not supplied; web-service setting skipped.");
  return { changed: web.changed, workflowChanged: workflow ? workflow.changed : [] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await syncRenderAiEnv({ env: process.env, apiKey: process.env.RENDER_API_KEY });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Render AI environment sync failed.");
    process.exitCode = 1;
  }
}
