import { pathToFileURL } from "node:url";

const SERVICE_ID = "srv-dbm8a6e1egvs73bl8d90";
const API_ORIGIN = "https://api.render.com";
const HOOK_PATH = `/deploy/${SERVICE_ID}`;
const PUBLIC_HOST = "agentshelf-e5bk.onrender.com";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function validate(env) {
  const { RENDER_DEPLOY_HOOK_URL: hookValue, GITHUB_SHA: commit, PUBLIC_BASE_URL: baseUrl } = env;
  if (!hookValue || !commit || !baseUrl || !env.RENDER_API_KEY) {
    throw new Error("Missing deploy configuration.");
  }
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error("GITHUB_SHA must be a full commit SHA.");

  let hook;
  try {
    hook = new URL(hookValue);
  } catch {
    throw new Error("Render deploy hook URL is invalid.");
  }
  if (
    hook.protocol !== "https:" ||
    hook.hostname !== "api.render.com" ||
    hook.port !== "" ||
    hook.username !== "" ||
    hook.password !== "" ||
    hook.pathname !== HOOK_PATH ||
    !hook.searchParams.has("key")
  ) {
    throw new Error("Render deploy hook URL does not match the expected service.");
  }
  const hookKey = hook.searchParams.get("key");
  if (!hookKey || [...hook.searchParams.keys()].some((name) => name !== "key" && name !== "ref")) {
    throw new Error("Render deploy hook URL has invalid query parameters.");
  }

  let publicUrl;
  try {
    publicUrl = new URL(baseUrl);
  } catch {
    throw new Error("Public service URL is invalid.");
  }
  if (
    publicUrl.protocol !== "https:" ||
    publicUrl.hostname !== PUBLIC_HOST ||
    publicUrl.port !== "" ||
    publicUrl.username !== "" ||
    publicUrl.password !== "" ||
    publicUrl.pathname !== "/" ||
    publicUrl.search !== "" ||
    publicUrl.hash !== ""
  ) {
    throw new Error("Public service URL does not match the expected demo.");
  }
  return { commit, hookKey, publicUrl, apiKey: env.RENDER_API_KEY };
}

async function renderRequest(fetchImpl, apiKey, path, init = {}) {
  const url = new URL(path, API_ORIGIN);
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", ...init.headers },
    });
  } catch {
    throw new Error("Render API request failed before receiving a response.");
  }
  if (response.status !== 200) throw new Error(`Render API request failed (HTTP ${response.status}).`);
  try {
    return await response.json();
  } catch {
    throw new Error("Render API returned invalid JSON.");
  }
}

async function listDeploys(fetchImpl, apiKey) {
  const payload = await renderRequest(fetchImpl, apiKey, `/v1/services/${SERVICE_ID}/deploys?limit=100`);
  if (!Array.isArray(payload)) throw new Error("Render returned an invalid deploy list.");
  return payload.map((entry) => entry?.deploy).filter((deploy) =>
    deploy && typeof deploy.id === "string" && typeof deploy.status === "string",
  );
}

async function verifyHealth(fetchImpl, publicUrl, commit) {
  const healthUrl = new URL("/api/health", publicUrl);
  let healthResponse;
  try {
    healthResponse = await fetchImpl(healthUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
      headers: { "cache-control": "no-cache" },
    });
  } catch {
    return false;
  }
  if (healthResponse.status !== 200) return false;
  let health;
  try {
    health = await healthResponse.json();
  } catch {
    return false;
  }
  if (health?.commit !== commit) return false;

  for (const path of ["/api/health/ready", "/"]) {
    try {
      const response = await fetchImpl(new URL(path, publicUrl), {
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
        headers: { "cache-control": "no-cache" },
      });
      if (response.status !== 200) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export async function deployAndVerify({ env, fetchImpl = fetch, sleepImpl = wait, now = Date.now, logger = console }) {
  const { commit, hookKey, publicUrl, apiKey } = validate(env);

  // Capture the baseline immediately before the exact-SHA deploy hook.
  const baseline = await listDeploys(fetchImpl, apiKey);
  const baselineIds = new Set(baseline.map((deploy) => deploy.id));
  const deployUrl = new URL(HOOK_PATH, API_ORIGIN);
  deployUrl.searchParams.set("key", hookKey);
  deployUrl.searchParams.set("ref", commit);
  let hookResponse;
  try {
    hookResponse = await fetchImpl(deployUrl, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Render deploy request failed before receiving a response.");
  }
  if (hookResponse.status !== 200 && hookResponse.status !== 202) {
    throw new Error(`Render rejected deploy request (HTTP ${hookResponse.status}).`);
  }
  let hookDeployId;
  if (hookResponse.status === 200) {
    try {
      const payload = await hookResponse.json();
      const id = payload?.id ?? payload?.deploy?.id;
      if (typeof id === "string" && id.length > 0) hookDeployId = id;
    } catch {
      // Some successful Deploy Hook responses do not include a JSON deploy ID.
    }
  }

  const deadline = now() + 15 * 60_000;
  let lastReport = 0;
  while (now() < deadline) {
    const deploys = await listDeploys(fetchImpl, apiKey);
    const candidate = deploys.find((deploy) =>
      !baselineIds.has(deploy.id) &&
      deploy.trigger === "deploy_hook" &&
      deploy.commit?.id === commit &&
      (!hookDeployId || deploy.id === hookDeployId),
    );
    if (candidate) {
      if (["build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"].includes(candidate.status)) {
        throw new Error(`The new Render deploy failed before going live for commit ${commit}.`);
      }
      if (candidate.status === "live" && await verifyHealth(fetchImpl, publicUrl, commit)) {
        logger.log(`A new Render deploy is live for commit ${commit}; health and readiness checks passed.`);
        return { commit };
      }
    }

    if (now() - lastReport >= 60_000) {
      logger.log(`Waiting for a new Render deploy to become live at commit ${commit}.`);
      lastReport = now();
    }
    await sleepImpl(10_000);
  }

  throw new Error(`Render did not verify a new live deploy for commit ${commit} within 15 minutes.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await deployAndVerify({ env: process.env });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Render deploy failed.");
    process.exitCode = 1;
  }
}
