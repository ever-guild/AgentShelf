import "server-only";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { getDb } from "../db";
import { publicOrigin } from "../public-origin";
import { isAllowedMcpOrigin } from "./origin";
import { PostgresIdentityStore } from "../seller-identity/postgres-store";
import { createSellerAgentServices } from "./seller-adapters";
import { createSellerMcpServer } from "./seller-server";

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;

function bearerToken(request: Request): string | undefined {
  return bearerValue(request.headers.get("authorization"));
}

function bearerValue(value: string | null | undefined): string | undefined {
  if (!value || value.length > 160) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(value);
  return match?.[1];
}

export async function handleSellerMcpRequest(request: Request, shopId?: string): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });

  let origin: URL;
  try {
    origin = new URL(publicOrigin());
  } catch {
    return new Response("Seller MCP is not configured", { status: 503 });
  }
  const expectedHost = origin.host;
  if (request.headers.get("host") !== expectedHost) return new Response("Invalid Host header", { status: 403 });
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin && !isAllowedMcpOrigin(requestOrigin)) return new Response("Forbidden", { status: 403 });
  const grantToken = bearerToken(request);
  if (!grantToken) return new Response("Bearer seller authorization is required", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  if (shopId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(shopId)) {
    return new Response("Invalid shop", { status: 404 });
  }

  const db = getDb();
  const identity = new PostgresIdentityStore((db as typeof db & { $client: import("pg").Pool }).$client);
  const services = createSellerAgentServices({
    db,
    identity,
    ...(shopId ? { shopId } : {}),
    allowShopCreation: shopId === undefined,
    grantTokenFromRequest: (extra) => {
      const headers = (extra as { requestInfo?: { headers?: Record<string, string | string[] | undefined> } } | undefined)?.requestInfo?.headers;
      const authorization = headers?.authorization;
      return bearerValue(Array.isArray(authorization) ? undefined : authorization);
    },
  });
  const server = createSellerMcpServer(services);
  const allowedOrigins = new Set([
    "https://claude.ai",
    "https://chatgpt.com",
    origin.origin,
    ...(process.env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  ]);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_REQUEST_BYTES,
    allowedHosts: [expectedHost],
    allowedOrigins: [...allowedOrigins],
    enableDnsRebindingProtection: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
