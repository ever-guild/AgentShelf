// Checks a running MCP endpoint over HTTP: initialize, list tools, find the seeded product and
// reject bad input. Usage: npm run smoke:mcp -- https://YOUR-SERVICE.onrender.com/mcp
//
// It never sends a valid checkout, so running it cannot create an order.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { DEMO_PRODUCT_ID } from "../src/server/db/seed";

function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!passed) {
    process.exitCode = 1;
  }
}

function firstText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [first] = result.content as { type: string; text?: string }[];
  return first?.text ?? "";
}

async function main() {
  const url = new URL(process.argv[2] ?? "http://localhost:3000/mcp");
  console.log(`Endpoint: ${url.href}`);

  const client = new Client({ name: "agentshelf-smoke", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  const server = client.getServerVersion();
  check("initialize", server?.name === "agentshelf", server?.name);

  const { tools } = await client.listTools();
  const hints = new Map(
    tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint]),
  );
  check(
    "tools/list",
    hints.get("search_products") === true &&
      hints.get("create_checkout") === false &&
      hints.get("get_order_status") === true,
    tools.map((tool) => tool.name).join(", "),
  );

  const found = await client.callTool({
    name: "search_products",
    arguments: { query: "iPhone 13 screen protector", location: "Liepāja" },
  });
  const products =
    (found.structuredContent as { products?: { productId: string }[] })
      ?.products ?? [];
  check(
    "search_products finds the seeded product",
    products.some((product) => product.productId === DEMO_PRODUCT_ID),
    firstText(found),
  );

  const malformed = await client.callTool({
    name: "search_products",
    arguments: { query: "" },
  });
  check("search_products rejects malformed input", malformed.isError === true);

  const tampered = await client.callTool({
    name: "create_checkout",
    arguments: {
      items: [{ productId: DEMO_PRODUCT_ID, quantity: 1 }],
      idempotencyKey: "00000000-0000-4000-8000-000000000000",
      totalMinor: 1,
    },
  });
  check("create_checkout rejects a client total", tampered.isError === true);

  await client.close();
}

main().catch((error) => {
  console.error("FAIL ", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
