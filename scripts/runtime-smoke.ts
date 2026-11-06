/**
 * Exercises the composed seller-owner, seller MCP, inventory, and buyer MCP paths
 * against a disposable local AgentShelf database
 *
 * This script creates an owner, shops, a draft import, and catalog/inventory rows
 * It attempts one negative checkout against a shop without PayPal configuration
 * It never calls PayPal or prints bearer grants or cookies
 *
 * Usage: npm run smoke:runtime -- http://localhost:3000
 */
import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type JsonRecord = Record<string, unknown>;
type SmokeShop = {
  id: string;
  name: string;
  slug: string;
  location: string;
  currency: "EUR";
  timezone: string;
};

const timeoutMs = 10_000;
const importTimeoutMs = 45_000;

class RuntimeSmokeBlocked extends Error {}
class RuntimeSmokeFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

function pass(name: string) {
  console.log(`PASS  ${name}`);
}

function assert(condition: unknown, name: string): asserts condition {
  if (!condition) throw new Error(name);
  pass(name);
}

function assertHttpStatus(
  response: Response,
  body: JsonRecord,
  expected: number,
  name: string,
) {
  if (response.status !== expected) {
    const code = string(body.code);
    const safeCode = code && /^[A-Z0-9_]{1,48}$/.test(code) ? code : "HTTP_ERROR";
    throw new RuntimeSmokeFailure(`HTTP_${response.status}_${safeCode}`);
  }
  pass(name);
}

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isAuthorizationStatus(error: unknown): boolean {
  const value = record(error);
  const status = value.status ?? value.code;
  return status === 401 || status === 403;
}

function isAuthorizationResult(result: Awaited<ReturnType<Client["callTool"]>>): boolean {
  if (!result.isError) return false;
  const structured = record(result.structuredContent);
  if (["UNAUTHORIZED", "AGENT_AUTHORIZATION_REQUIRED"].includes(String(structured.code))) return true;
  const blocks = result.content as { type: string; text?: string }[];
  for (const block of blocks) {
    if (block.type !== "text" || !block.text) continue;
    try {
      const parsed = record(JSON.parse(block.text));
      if (["UNAUTHORIZED", "AGENT_AUTHORIZATION_REQUIRED"].includes(String(parsed.code))) return true;
    } catch {
      // Ignore unstructured MCP error details; never log them
    }
  }
  return false;
}

function toolErrorCode(result: Awaited<ReturnType<Client["callTool"]>>): string | undefined {
  const structuredCode = string(record(result.structuredContent).code);
  if (structuredCode) return structuredCode;
  const blocks = result.content as { type: string; text?: string }[];
  for (const block of blocks) {
    if (block.type !== "text" || !block.text) continue;
    try {
      return string(record(JSON.parse(block.text)).code);
    } catch {
      // Never expose unstructured provider output
    }
  }
  return undefined;
}

function parseToolResult(result: Awaited<ReturnType<Client["callTool"]>>): JsonRecord {
  if (result.isError) throw new RuntimeSmokeFailure(toolErrorCode(result) ?? "MCP_OPERATION_FAILED");
  if (result.structuredContent) return record(result.structuredContent);
  const blocks = result.content as { type: string; text?: string }[];
  const first = blocks.find((item) => item.type === "text");
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("MCP operation returned no structured result");
  }
  try {
    return record(JSON.parse(first.text));
  } catch {
    throw new Error("MCP operation returned an invalid result");
  }
}

function parseCookie(headers: Headers): string | undefined {
  for (const line of headers.getSetCookie()) {
    const value = line.split(";", 1)[0];
    if (value.startsWith("agentshelf_owner_session=")) return value;
  }
  return undefined;
}

async function fetchJson(
  url: URL,
  init: RequestInit = {},
): Promise<{ response: Response; body: JsonRecord }> {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body: JsonRecord = {};
  if (response.status !== 204) {
    try {
      body = record(await response.json());
    } catch {
      throw new Error("HTTP endpoint returned invalid JSON");
    }
  }
  return { response, body };
}

async function ownerPost(
  origin: URL,
  path: string,
  payload: JsonRecord,
  cookie?: string,
): Promise<{ response: Response; body: JsonRecord; cookie?: string }> {
  const headers = new Headers({
    origin: origin.origin,
    "content-type": "application/json",
  });
  if (cookie) headers.set("cookie", cookie);
  const result = await fetchJson(new URL(path, origin), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  return { ...result, cookie: parseCookie(result.response.headers) ?? cookie };
}

async function connectMcp(url: URL, bearer?: string) {
  const headers = new Headers({ origin: url.origin });
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  const client = new Client({ name: "agentshelf-runtime-smoke", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url, {
    fetch: (input, init) => fetch(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    }),
    requestInit: { headers },
    reconnectionOptions: { maxReconnectionDelay: 1_000, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1.2, maxRetries: 1 },
  }));
  return client;
}

function parseBaseUrl(value: string | undefined): URL {
  if (process.env.RUNTIME_SMOKE_DISPOSABLE_DB !== "1") {
    throw new RuntimeSmokeBlocked("set RUNTIME_SMOKE_DISPOSABLE_DB=1 only when the local app uses a disposable database");
  }
  if (!value) throw new Error("Pass a local URL, for example http://localhost:3000");
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/"
  ) {
    throw new Error("Runtime smoke only runs against a local HTTP origin and disposable database");
  }
  return url;
}

async function main() {
  const origin = parseBaseUrl(process.argv[2]);
  const runId = randomUUID().replaceAll("-", "").slice(0, 10);
  const ownerName = `qa${runId}`;
  const password = `Runtime-${randomUUID()}-Q4`;
  const shopSeed = {
    location: "QA local test",
    currency: "EUR" as const,
    timezone: "Europe/Riga",
  };

  const unauthenticated = await fetchJson(new URL("/api/seller/identity/me", origin));
  assert(unauthenticated.response.status === 401, "owner data is unavailable without an owner session");

  const registration = await ownerPost(origin, "/api/seller/identity/register", {
    username: ownerName,
    password,
    idempotencyKey: randomUUID(),
  });
  assertHttpStatus(registration.response, registration.body, 201, "owner can register without seed data");
  let cookie = registration.cookie;
  assert(Boolean(cookie), "owner registration starts an authenticated session");

  const me = await fetchJson(new URL("/api/seller/identity/me", origin), {
    headers: { cookie: cookie! },
  });
  assert(me.response.status === 200 && Array.isArray(me.body.shops) && me.body.shops.length === 0,
    "new owner has an empty shop list before registration");

  const created = await ownerPost(origin, "/api/seller/identity/shops", {
    shop: {
      ...shopSeed,
      name: `Runtime QA ${runId}`,
      slug: `runtime-qa-${runId}`,
    },
    idempotencyKey: randomUUID(),
  }, cookie);
  assert(created.response.status === 201, "owner can create a shop through the identity API");
  cookie = created.cookie ?? cookie!;
  const ownerShop = record(created.body.shop) as unknown as SmokeShop;
  assert(Boolean(ownerShop.id), "owner-created shop is returned");

  const signedIn = await ownerPost(origin, "/api/seller/identity/sign-in", {
    username: ownerName,
    password,
  }, cookie);
  assert(signedIn.response.status === 200, "owner can sign in to the newly registered account");
  cookie = signedIn.cookie ?? cookie;
  const afterSignIn = await fetchJson(new URL("/api/seller/identity/me", origin), {
    headers: { cookie },
  });
  const signedInShops = Array.isArray(afterSignIn.body.shops) ? afterSignIn.body.shops : [];
  assert(afterSignIn.response.status === 200 && signedInShops.length === 1,
    "owner sign-in restores persisted shop membership");

  const createGrant = await ownerPost(origin, "/api/seller/identity/agent-grants", {
    shopId: null,
    scopes: ["create_shop"],
  }, cookie);
  assert(createGrant.response.status === 201, "owner can issue a separate onboarding grant");
  const createShopToken = string(createGrant.body.grantToken);
  assert(Boolean(createShopToken), "owner receives an opaque onboarding grant once");

    const shopGrantDenied = await deniedToolCall(
      new URL(`/mcp/seller/shop/${encodeURIComponent(ownerShop.id)}`, origin),
      createShopToken!,
      "seller_manage_catalog",
      { action: "list" },
    );
    assert(shopGrantDenied, "onboarding grant cannot access a shop-management endpoint");

  const onboardingClient = await connectMcp(new URL("/mcp/seller/onboarding", origin), createShopToken);
  try {
    const listed = await onboardingClient.listTools();
    const toolNames = listed.tools.map((tool) => tool.name);
    assert(toolNames.includes("seller_create_shop"), "onboarding MCP exposes seller_create_shop");
    assert(toolNames.length === 1, "onboarding MCP exposes no shop-management tools");
    const onboarded = parseToolResult(await onboardingClient.callTool({
      name: "seller_create_shop",
      arguments: {
        shop: {
          ...shopSeed,
          name: `Agent QA ${runId}`,
          slug: `agent-qa-${runId}`,
        },
        idempotencyKey: randomUUID(),
      },
    }));
    const agentShop = record(onboarded.shop) as unknown as SmokeShop;
    assert(Boolean(agentShop.id), "authorized seller agent can create its owner’s shop");
    assert(onboarded.paymentStatus === "not_configured", "new seller-agent shop starts without PayPal consent");

    const agentGrant = await ownerPost(origin, "/api/seller/identity/agent-grants", {
      shopId: agentShop.id,
      scopes: ["read_shop", "manage_catalog", "manage_inventory"],
    }, cookie);
    assert(agentGrant.response.status === 201, "owner can issue shop-bound seller permissions");
    const agentToken = string(agentGrant.body.grantToken);
    assert(Boolean(agentToken), "shop-bound grant is returned once");

    await verifyCrossShopDenied(origin, agentShop.id, agentToken!, cookie, runId);
    const revocationGrant = await ownerPost(origin, "/api/seller/identity/agent-grants", {
      shopId: agentShop.id,
      scopes: ["read_shop", "manage_catalog", "manage_inventory"],
    }, cookie);
    assert(revocationGrant.response.status === 201, "owner can issue a second independent shop grant");
    const revocationToken = string(revocationGrant.body.grantToken);
    assert(Boolean(revocationToken), "second grant is returned once for revocation testing");
    await verifyGrantRevocation(origin, agentShop.id, revocationToken!, cookie, runId);

    await runShopMcp(origin, agentShop, agentToken!, runId);
  } finally {
    await onboardingClient.close();
  }

  const signOut = await ownerPost(origin, "/api/seller/identity/sign-out", {}, cookie);
  assert(signOut.response.status === 204, "owner can revoke its session");
  const afterSignOut = await fetchJson(new URL("/api/seller/identity/me", origin), {
    headers: { cookie: cookie! },
  });
  assert(afterSignOut.response.status === 401, "revoked owner session is rejected");
}

async function runShopMcp(origin: URL, shop: SmokeShop, token: string, runId: string) {
  const route = `/mcp/seller/shop/${encodeURIComponent(shop.id)}`;
  const client = await connectMcp(new URL(route, origin), token);
  let publishedProductId: string | undefined;
  let importId: string | undefined;
  const title = `Runtime QA Product ${runId}`;
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert(names.includes("seller_import_price_list"), "seller MCP exposes import");
    assert(names.includes("seller_review_import"), "seller MCP exposes review and publish");
    assert(names.includes("seller_manage_catalog"), "seller MCP exposes catalog read");
    assert(names.includes("seller_manage_stock"), "seller MCP exposes inventory management");

    const injectedTenant = await client.callTool({
      name: "seller_manage_catalog",
      arguments: { action: "list", shopId: randomUUID() },
    });
    assert(injectedTenant.isError === true, "seller MCP rejects tenant IDs in tool arguments");

    const csv = [
      "name,kind,price,currency,description",
      `${title},product,12.50,EUR,Disposable runtime smoke item`,
    ].join("\n");
    const importResult = await client.callTool({
      name: "seller_import_price_list",
      arguments: {
        fileName: `runtime-${runId}.csv`,
        contentType: "text/csv",
        contentBase64: Buffer.from(csv).toString("base64"),
      },
    });
    if (importResult.isError && toolErrorCode(importResult) === "IMPORT_NOT_CONFIGURED") {
      throw new RuntimeSmokeBlocked("AI provider configuration is required for the import rehearsal");
    }
    const imported = parseToolResult(importResult);
    importId = string(imported.importId);
    assert(Boolean(importId), "seller MCP accepts a synthetic CSV import");

    let review = {} as JsonRecord;
    const deadline = Date.now() + importTimeoutMs;
    while (Date.now() < deadline) {
      review = parseToolResult(await client.callTool({
        name: "seller_review_import",
        arguments: { action: "get", importId },
      }));
      const status = string(review.status);
      if (status === "needs_review" || status === "completed" || status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert(review.status === "needs_review", "import reaches a seller-reviewable state");

    await client.callTool({
      name: "seller_review_import",
      arguments: { action: "accept_clean", importId },
    }).then(parseToolResult);
    const published = parseToolResult(await client.callTool({
      name: "seller_review_import",
      arguments: { action: "publish", importId },
    }));
    assert(published.status === "completed", "seller review publishes the imported catalog row");

    const catalog = parseToolResult(await client.callTool({
      name: "seller_manage_catalog",
      arguments: { action: "list" },
    }));
    const products = Array.isArray(catalog.products) ? catalog.products.map(record) : [];
    const product = products.find((item) => item.title === title && item.status === "published");
    publishedProductId = string(product?.id);
    assert(Boolean(publishedProductId), "published catalog row is visible to its shop agent");

    const stockSet = parseToolResult(await client.callTool({
      name: "seller_manage_stock",
      arguments: {
        action: "set_mode",
        productId: publishedProductId,
        mode: "tracked",
        onHand: 2,
        reason: "Runtime smoke initializes disposable stock",
        idempotencyKey: `qa-stock-init-${runId}`,
      },
    }));
    assert(stockSet.mode === "tracked" && stockSet.available === 2, "seller agent initializes tracked quantity");
    assert(Number.isInteger(stockSet.version), "stock mode response includes a version for safe adjustment");

    const adjusted = parseToolResult(await client.callTool({
      name: "seller_manage_stock",
      arguments: {
        action: "adjust",
        productId: publishedProductId,
        delta: -1,
        expectedVersion: stockSet.version,
        reason: "Runtime smoke checks quantity adjustment",
        idempotencyKey: `qa-stock-dec-${runId}`,
      },
    }));
    assert(adjusted.onHand === 1 && adjusted.available === 1, "stock adjustment leaves one available unit");

    await verifyBuyerSearch(origin, title, publishedProductId!);
    await verifyUnconfiguredCheckout(origin, publishedProductId!);
  } finally {
    await client.close();
  }

  // Keep useful local evidence without exposing the generated account or grant values
  assert(Boolean(importId), "synthetic import path completed");
}

async function verifyBuyerSearch(origin: URL, title: string, productId: string) {
  const client = await connectMcp(new URL("/mcp", origin));
  try {
    const listed = await client.listTools();
    assert(listed.tools.some((tool) => tool.name === "search_products"), "buyer MCP remains available");
    const result = parseToolResult(await client.callTool({
      name: "search_products",
      arguments: { query: title },
    }));
    const products = Array.isArray(result.products) ? result.products.map(record) : [];
    assert(products.some((item) => item.productId === productId), "buyer MCP finds the seller-published item");
  } finally {
    await client.close();
  }
}

async function verifyUnconfiguredCheckout(origin: URL, productId: string) {
  const client = await connectMcp(new URL("/mcp", origin));
  try {
    const listed = await client.listTools();
    assert(listed.tools.some((tool) => tool.name === "create_checkout"), "buyer MCP exposes checkout");
    const result = await client.callTool({
      name: "create_checkout",
      arguments: { items: [{ productId, quantity: 1 }], idempotencyKey: randomUUID() },
    });
    const structured = record(result.structuredContent);
    const hasApprovalUrl = typeof structured.approvalUrl === "string" ||
      (result.content as { type: string; text?: string }[]).some((block) =>
        block.type === "text" && /https?:\/\//i.test(block.text ?? ""),
      );
    assert(result.isError === true && toolErrorCode(result) === "PAYMENT_NOT_CONFIGURED",
      "unconfigured seller checkout is rejected before payment setup");
    assert(!hasApprovalUrl && typeof structured.orderId !== "string",
      "unconfigured checkout returns no approval URL or order capability");
  } finally {
    await client.close();
  }
}

async function deniedToolCall(url: URL, token: string, name: string, args: JsonRecord): Promise<boolean> {
  let client: Client | undefined;
  try {
    client = await connectMcp(url, token);
    return isAuthorizationResult(await client.callTool({ name, arguments: args }));
  } catch (error) {
    return isAuthorizationStatus(error);
  } finally {
    await client?.close();
  }
}

async function verifyCrossShopDenied(origin: URL, shopId: string, grant: string, cookie: string, runId: string) {
  const second = await ownerPost(origin, "/api/seller/identity/shops", {
    shop: {
      name: `Foreign QA ${runId}`,
      slug: `foreign-qa-${runId}`,
      location: "QA local test",
      currency: "EUR",
      timezone: "Europe/Riga",
    },
    idempotencyKey: randomUUID(),
  }, cookie);
  assert(second.response.status === 201, "owner can create a second isolated shop");
  const otherShopId = string(record(second.body.shop).id);
  assert(Boolean(otherShopId) && otherShopId !== shopId, "second shop has a distinct tenant id");

  let denied = false;
  let client: Client | undefined;
  try {
    client = await connectMcp(new URL(`/mcp/seller/shop/${encodeURIComponent(otherShopId!)}`, origin), grant);
    const result = await client.callTool({ name: "seller_manage_catalog", arguments: { action: "list" } });
    denied = isAuthorizationResult(result);
  } catch (error) {
    denied = isAuthorizationStatus(error);
  } finally {
    await client?.close();
  }
  assert(denied, "shop-bound grant is denied on another shop route");
}

async function verifyGrantRevocation(origin: URL, shopId: string, token: string, cookie: string, runId: string) {
  const revoked = await ownerPost(origin, "/api/seller/identity/agent-grants/revoke", {
    grantToken: token,
  }, cookie);
  assert(revoked.response.status === 204, "owner can revoke seller-agent consent");

  let client: Client | undefined;
  try {
    let denied = false;
    try {
      client = await connectMcp(new URL(`/mcp/seller/shop/${encodeURIComponent(shopId)}`, origin), token);
      const result = await client.callTool({ name: "seller_manage_catalog", arguments: { action: "list" } });
      denied = isAuthorizationResult(result);
    } catch (error) {
      denied = isAuthorizationStatus(error);
    }
    assert(denied, `revoked seller-agent grant is rejected (${runId})`);
  } finally {
    await client?.close();
  }
}

main().catch((error: unknown) => {
  // Do not print fetch errors, response bodies, cookies, grants, or generated credentials
  if (error instanceof RuntimeSmokeBlocked) {
    console.error(`BLOCKED  ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (error instanceof RuntimeSmokeFailure) {
    console.error(`FAIL  seller API returned safe status/code ${error.code}`);
    process.exitCode = 1;
    return;
  }
  console.error("FAIL  Runtime smoke failed; details are suppressed to protect session data");
  process.exitCode = 1;
});
