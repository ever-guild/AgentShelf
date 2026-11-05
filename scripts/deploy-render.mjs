const expectedHost = "api.render.com";
const expectedPath = "/deploy/srv-dbm8a6e1egvs73bl8d90";
const baseUrl = process.env.PUBLIC_BASE_URL;
const commit = process.env.GITHUB_SHA;
const hookValue = process.env.RENDER_DEPLOY_HOOK_URL;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!hookValue || !commit || !baseUrl) fail("Missing deploy configuration.");
if (!/^[0-9a-f]{40}$/i.test(commit)) fail("GITHUB_SHA must be a full commit SHA.");

let hook;
try {
  hook = new URL(hookValue);
} catch {
  fail("Render deploy hook URL is invalid.");
}
if (
  hook.protocol !== "https:" ||
  hook.hostname !== expectedHost ||
  hook.port !== "" ||
  hook.username !== "" ||
  hook.password !== "" ||
  hook.pathname !== expectedPath ||
  !hook.searchParams.has("key")
) {
  fail("Render deploy hook URL does not match the expected service.");
}
const key = hook.searchParams.get("key");
if (!key || [...hook.searchParams.keys()].some((name) => name !== "key" && name !== "ref")) {
  fail("Render deploy hook URL has invalid query parameters.");
}

let publicUrl;
try {
  publicUrl = new URL(baseUrl);
} catch {
  fail("Public service URL is invalid.");
}
if (publicUrl.protocol !== "https:" || publicUrl.hostname !== "agentshelf-e5bk.onrender.com") {
  fail("Public service URL does not match the expected demo.");
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deployUrl = new URL(expectedPath, "https://api.render.com");
deployUrl.searchParams.set("key", key);
deployUrl.searchParams.set("ref", commit);
let response;
try {
  response = await fetch(deployUrl, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
} catch {
  fail("Render deploy request failed before receiving a response.");
}
if (response.status !== 200 && response.status !== 202) {
  fail(`Render rejected deploy request (HTTP ${response.status}).`);
}
if (response.status === 200) {
  try {
    const payload = await response.json();
    const deployId = payload?.id ?? payload?.deploy?.id;
    if (typeof deployId === "string" && deployId.length > 0) {
      console.log(`Render started deploy ${deployId}.`);
    } else {
      console.log("Render started the deploy.");
    }
  } catch {
    console.log("Render started the deploy.");
  }
} else {
  console.log("Render queued the deploy behind an in-progress deployment.");
}

const deadline = Date.now() + 15 * 60_000;
let lastReport = 0;
while (Date.now() < deadline) {
  try {
    const healthResponse = await fetch(new URL("/api/health", publicUrl), {
      signal: AbortSignal.timeout(8_000),
      headers: { "cache-control": "no-cache" },
    });
    if (healthResponse.status === 200) {
      const health = await healthResponse.json();
      if (health.commit === commit) {
        const readyResponse = await fetch(new URL("/api/health/ready", publicUrl), {
          signal: AbortSignal.timeout(8_000),
          headers: { "cache-control": "no-cache" },
        });
        if (readyResponse.status === 200) {
          const homeResponse = await fetch(publicUrl, {
            signal: AbortSignal.timeout(8_000),
            headers: { "cache-control": "no-cache" },
          });
          if (homeResponse.status === 200) {
            console.log(`Render deploy verified for commit ${commit}.`);
            console.log(`Public URLs: ${publicUrl.href}, ${new URL("/api/health", publicUrl).href}, ${new URL("/api/health/ready", publicUrl).href}`);
            process.exit(0);
          }
        }
      }
    }
  } catch {
    // The service may be restarting; keep polling until the bounded deadline.
  }

  if (Date.now() - lastReport >= 60_000) {
    console.log(`Waiting for Render to serve commit ${commit} with readiness HTTP 200.`);
    lastReport = Date.now();
  }
  await wait(10_000);
}

fail(`Render deploy did not become healthy with commit ${commit} within 15 minutes.`);
