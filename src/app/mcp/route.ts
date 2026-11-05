import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { getDb } from "@/server/db";
import { isAllowedMcpOrigin } from "@/server/mcp/origin";
import { createMcpServer } from "@/server/mcp/server";

const MAX_REQUEST_BYTES = 64 * 1024;

// Stateless Streamable HTTP. Each POST gets its own server and transport, so nothing has to
// survive between requests when an instance restarts or sleeps. This route exports no GET or
// DELETE, so Next.js answers those with 405, as the specification allows for a server with no
// server-initiated stream.
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && !isAllowedMcpOrigin(origin)) {
    console.warn("Rejected MCP request from origin", origin);
    return new Response("Forbidden", { status: 403 });
  }

  const server = createMcpServer(getDb());
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_REQUEST_BYTES,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
