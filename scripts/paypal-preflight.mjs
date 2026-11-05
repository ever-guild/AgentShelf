import { pathToFileURL } from "node:url";

export const PAYPAL_SANDBOX_TOKEN_URL =
  "https://api-m.sandbox.paypal.com/v1/oauth2/token";
export const PAYPAL_CREDENTIAL_REFS = [
  "DEMO_PHONE_WORKSHOP",
  "DEMO_SECOND_SHOP",
];

function isHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      (url.pathname === "/" || url.pathname === "") &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

/** @param {Record<string, string | undefined>} [env] */
export function inspectConfiguration(env = process.env) {
  const missing = [];
  for (const ref of PAYPAL_CREDENTIAL_REFS) {
    for (const suffix of ["CLIENT_ID", "CLIENT_SECRET"]) {
      const name = `PAYPAL_${suffix}_${ref}`;
      if (!env[name]?.trim()) missing.push(name);
    }

    const merchantName = `${ref}_PAYPAL_MERCHANT_ID`;
    if (!env[merchantName]?.trim()) missing.push(merchantName);
  }

  const uniquePairs = [
    ["PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP", "PAYPAL_CLIENT_ID_DEMO_SECOND_SHOP"],
    ["DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID", "DEMO_SECOND_SHOP_PAYPAL_MERCHANT_ID"],
  ];
  for (const [first, second] of uniquePairs) {
    if (
      env[first]?.trim() &&
      env[second]?.trim() &&
      env[first].trim() === env[second].trim()
    ) {
      missing.push(`duplicate values for ${first} and ${second}`);
    }
  }

  if (!isHttpsOrigin(env.APP_ORIGIN ?? "")) {
    missing.push("APP_ORIGIN (must be an HTTPS origin)");
  }
  return missing;
}

/**
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {boolean} [options.online]
 * @param {(url: string, init: RequestInit) => Promise<Response>} [options.fetchImpl]
 * @param {(message: string) => void} [options.log]
 * @param {number} [options.timeoutMs]
 */
export async function runPreflight({
  env = process.env,
  online = false,
  fetchImpl = fetch,
  log = console.log,
  timeoutMs = 10_000,
} = {}) {
  const missing = inspectConfiguration(env);
  if (missing.length > 0) {
    log(`BLOCKED missing or invalid configuration: ${missing.join(", ")}`);
    return 2;
  }

  log("PASS required sandbox configuration is present (values hidden)");
  if (!online) {
    log("OFFLINE configuration-only check; no PayPal requests were made");
    return 0;
  }

  for (const ref of PAYPAL_CREDENTIAL_REFS) {
    const id = env[`PAYPAL_CLIENT_ID_${ref}`];
    const secret = env[`PAYPAL_CLIENT_SECRET_${ref}`];
    try {
      const response = await fetchImpl(PAYPAL_SANDBOX_TOKEN_URL, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: "grant_type=client_credentials",
      });

      if (!response.ok) {
        log(`FAIL sandbox OAuth for ${ref} (HTTP ${response.status})`);
        return 1;
      }

      const payload = await response.json();
      if (
        typeof payload?.access_token !== "string" ||
        !payload.access_token.trim() ||
        typeof payload?.token_type !== "string" ||
        payload.token_type.toLowerCase() !== "bearer"
      ) {
        log(`FAIL sandbox OAuth for ${ref} (HTTP ${response.status}, token response invalid)`);
        return 1;
      }
      // Keep the token only in this local response object; never return or log it.
      log(`PASS sandbox OAuth for ${ref} (HTTP ${response.status})`);
    } catch {
      log(`FAIL sandbox OAuth for ${ref} (network error or timeout)`);
      return 1;
    }
  }

  log("OAuth checks do not verify merchant mapping, Orders, capture, webhooks, or runtime integration");
  return 0;
}

async function main(argv = process.argv.slice(2)) {
  const online = argv.length === 1 && argv[0] === "--online";
  if (argv.length > 0 && !online) {
    console.error("Usage: npm run paypal:preflight [-- --online]");
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runPreflight({ online });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
