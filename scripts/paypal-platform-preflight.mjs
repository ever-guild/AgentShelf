import { pathToFileURL } from "node:url";

export const SANDBOX_ORIGIN = "https://api-m.sandbox.paypal.com";
export const TOKEN_URL = `${SANDBOX_ORIGIN}/v1/oauth2/token`;
export const SELLER_STATUS_PATH = "/v1/customer/partners/{partnerId}/merchant-integrations/{sellerId}";

const REQUIRED = [
  "PAYPAL_PLATFORM_CLIENT_ID",
  "PAYPAL_PLATFORM_CLIENT_SECRET",
  "PAYPAL_PLATFORM_MERCHANT_ID",
  "PAYPAL_PARTNER_ATTRIBUTION_ID",
];

export function inspectPlatformConfiguration(env = process.env) {
  return REQUIRED.filter((name) => typeof env[name] !== "string" || !env[name].trim());
}

async function readJsonLimited(response, limitBytes = 64 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty response");
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limitBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("response too large");
    }
    chunks.push(Buffer.from(value));
  }
  if (size === 0) throw new Error("empty response");
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}

async function tokenFor(env, fetchImpl, timeoutMs) {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      authorization: `Basic ${Buffer.from(`${env.PAYPAL_PLATFORM_CLIENT_ID}:${env.PAYPAL_PLATFORM_CLIENT_SECRET}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) throw new Error(`OAuth HTTP ${response.status}`);
  const body = await readJsonLimited(response, 16 * 1024);
  if (typeof body?.access_token !== "string" || !body.access_token.trim() || body.token_type?.toLowerCase() !== "bearer") {
    throw new Error("OAuth response invalid");
  }
  return body.access_token;
}

/**
 * Read-only sandbox OAuth check and optional merchant-integration status GET.
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {boolean} [options.online]
 * @param {string} [options.sellerId]
 * @param {(url: string, init: RequestInit) => Promise<Response>} [options.fetchImpl]
 * @param {(message: string) => void} [options.log]
 * @param {number} [options.timeoutMs]
 */
export async function runPlatformPreflight({
  env = process.env,
  online = false,
  sellerId,
  fetchImpl = fetch,
  log = console.log,
  timeoutMs = 10_000,
} = {}) {
  const missing = inspectPlatformConfiguration(env);
  if (missing.length) {
    log(`BLOCKED missing platform configuration: ${missing.join(", ")}`);
    return 2;
  }
  if (sellerId && !/^[A-Za-z0-9_-]{3,128}$/.test(sellerId)) {
    log("BLOCKED seller merchant ID has invalid format");
    return 2;
  }
  log("PASS platform sandbox configuration is present (values hidden)");
  if (!online) {
    log("OFFLINE configuration-only check; no PayPal requests were made");
    return 0;
  }

  try {
    const accessToken = await tokenFor(env, fetchImpl, timeoutMs);
    log("PASS platform sandbox OAuth (HTTP 200)");
    if (!sellerId) {
      log("OAuth only; no seller integration status was requested");
      return 0;
    }
    const url = `${SANDBOX_ORIGIN}/v1/customer/partners/${encodeURIComponent(env.PAYPAL_PLATFORM_MERCHANT_ID)}/merchant-integrations/${encodeURIComponent(sellerId)}`;
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: `Bearer ${accessToken}`,
        "PayPal-Partner-Attribution-Id": env.PAYPAL_PARTNER_ATTRIBUTION_ID,
        accept: "application/json",
      },
    });
    if (!response.ok) {
      log(`FAIL seller integration status (HTTP ${response.status}); response body hidden`);
      return 1;
    }
    const data = await readJsonLimited(response, 128 * 1024);
    const scopes = Array.isArray(data?.oauth_integrations)
      ? data.oauth_integrations
          .filter((integration) => integration?.integration_type === "OAUTH_THIRD_PARTY" && integration?.integration_method === "PAYPAL")
          .flatMap((integration) => Array.isArray(integration?.oauth_third_party)
            ? integration.oauth_third_party.flatMap((grant) => Array.isArray(grant?.scopes) ? grant.scopes : [])
            : [])
      : [];
    const activeProducts = Array.isArray(data?.products)
      ? data.products.filter((product) => product?.status === "ACTIVE").map((product) => product?.name)
      : [];
    const identityMatches = data?.merchant_id === sellerId;
    const hasPaymentScope = scopes.includes("https://uri.paypal.com/services/payments/payment/authcapture");
    const ready = identityMatches && data?.payments_receivable === true && data?.primary_email_confirmed === true &&
      activeProducts.includes("EXPRESS_CHECKOUT") && hasPaymentScope;
    log(`${ready ? "PASS" : "BLOCKED"} seller integration status (HTTP 200; merchant matches ${identityMatches}; payments receivable ${data?.payments_receivable === true}; primary email confirmed ${data?.primary_email_confirmed === true}; EXPRESS_CHECKOUT active ${activeProducts.includes("EXPRESS_CHECKOUT")}; capture scope granted ${hasPaymentScope})`);
    log("This read does not verify the shop-to-tracking-ID mapping, orders, capture, webhooks, or runtime integration");
    return ready ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error && /^OAuth HTTP \d+$/.test(error.message) ? error.message : "network error, timeout, redirect, or invalid response";
    log(`FAIL sandbox preflight (${message})`);
    return 1;
  }
}

export function parseCliArgs(argv) {
  let online = false;
  let sellerId;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--online" && !online) {
      online = true;
      continue;
    }
    if (arg === "--seller-id" && sellerId === undefined) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return undefined;
      sellerId = value;
      index += 1;
      continue;
    }
    return undefined;
  }
  if (sellerId && !online) return undefined;
  return { online, sellerId };
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  if (!parsed) {
    console.error("Usage: npm run paypal:platform-preflight [-- --online [--seller-id SANDBOX_MERCHANT_ID]]");
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runPlatformPreflight(parsed);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
