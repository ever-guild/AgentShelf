import { pathToFileURL } from "node:url";

const SERVICE_ID = "srv-dbm8a6e1egvs73bl8d90";
const API_ORIGIN = "https://api.render.com";
const MAPPINGS = [
  { source: "AGENT_SHELF_AI_PROVIDER", target: "AGENT_SHELF_AI_PROVIDER" },
  { source: "AGENT_SHELF_AI_PROVIDER_BASE_URL", target: "AGENT_SHELF_AI_PROVIDER_BASE_URL" },
  { source: "AGENT_SHELF_AI_PROVIDER_API_KEY", target: "AGENT_SHELF_AI_PROVIDER_API_KEY" },
  { source: "AGENT_SHELF_AG_STUDIO_LICENCE", target: "AG_STUDIO" },
];
const KEYS = MAPPINGS.map(({ target }) => target);

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

async function getCurrentValue(fetchImpl, apiKey, key) {
  const url = new URL(`/v1/services/${SERVICE_ID}/env-vars/${encodeURIComponent(key)}`, API_ORIGIN);
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

async function putValue(fetchImpl, apiKey, key, value) {
  const url = new URL(`/v1/services/${SERVICE_ID}/env-vars/${encodeURIComponent(key)}`, API_ORIGIN);
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
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new Error("Missing required configuration: RENDER_API_KEY.");
  }

  // Read all three values before writing so a read failure never leaves a partial sync.
  const current = {};
  for (const key of KEYS) current[key] = await getCurrentValue(fetchImpl, apiKey, key);

  const changed = KEYS.filter((key) => current[key] !== desired[key]);
  for (const key of changed) await putValue(fetchImpl, apiKey, key, desired[key]);

  const verified = {};
  for (const key of KEYS) verified[key] = await getCurrentValue(fetchImpl, apiKey, key);
  const mismatches = KEYS.filter((key) => verified[key] !== desired[key]);
  if (mismatches.length) throw new Error(`Render readback did not match GitHub Environment for: ${mismatches.join(", ")}.`);

  if (changed.length === 0) logger.log("Render AI environment already matches GitHub Environment; no updates made.");
  else logger.log(`Render AI environment synchronized: ${changed.join(", ")}.`);
  return { changed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await syncRenderAiEnv({ env: process.env, apiKey: process.env.RENDER_API_KEY });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Render AI environment sync failed.");
    process.exitCode = 1;
  }
}
