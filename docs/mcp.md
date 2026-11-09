# MCP connector

One remote connector covering all shops, for [#5](https://github.com/ever-guild/AgentShelf/issues/5). The endpoint is `POST /mcp` over Streamable HTTP, with the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

## Status

A client is marked working only after a real connection to it. Each row is separate evidence: a script, an SDK client or one assistant does not stand in for another.

| Check | Result |
| --- | --- |
| `smoke:mcp` and `smoke:demo` against a local production build with the fixture seed | **PASS** on 9 November 2026 at `37fea91`: initialize, list tools, search both demo shops, reject bad input, free repair slots. `create_checkout` on a fixture shop answered `PAYMENT_NOT_CONFIGURED` and created no order |
| Direct HTTPS JSON-RPC call to the deployed `/mcp` for a PayPal-connected shop | **PASS** on 8 November 2026: one `create_checkout` for EUR 1, approved in PayPal Sandbox by a person, captured for the right seller, and `get_order_status` reported `paid`, see [proof #2](https://github.com/ever-guild/AgentShelf/issues/2). This was a helper script, not an assistant |
| Claude Code CLI with an `http` server entry for the deployed `/mcp` | Connected and listed the five tools on 8 November 2026; no buyer tool was called |
| Claude custom connector (claude.ai) | **Not tested** |
| ChatGPT | **Not tested** |

## Tools

The schemas are in [`src/server/contracts/commerce.ts`](../src/server/contracts/commerce.ts). Inputs are strict, so a request carrying a total, a price, a merchant or any other unknown field is rejected.

| Tool | Kind | State |
| --- | --- | --- |
| `search_products` | Read-only for the caller | Works across all shops, in English, Latvian and Russian, with deterministic matching and no model call. Records each search as demand, and reports `matching.mode`. See [Search](architecture.md#search) |
| `create_checkout` | Write | Reserves stock and creates a PayPal sandbox order from the stored cart, then returns its approval link, which is not payment. A shop needs a ready PayPal connection, or legacy demo credentials, otherwise the answer is `PAYMENT_NOT_CONFIGURED` and no order is created. A physical product also needs an explicit stock policy and available units, otherwise `PRODUCT_UNAVAILABLE`. [architecture.md](architecture.md#checkout) lists its errors and when to retry |
| `get_slots` | Read-only | Lists free appointment times for a service, with exact instants, the shop's timezone and the technician. At most 100 per answer, and `truncated` says when there are more |
| `book_slot` | Write | Holds a slot for 15 minutes and creates a PayPal sandbox order for the service's deposit, and returns its approval link, which is not payment. The booking is confirmed only after a verified capture. Slots exist only for a shop with a technician and working hours, set up on `/seller/schedule`. The shop must be payment-ready, otherwise booking answers `PAYMENT_NOT_CONFIGURED`. A real Sandbox deposit has not been verified yet; booking setup for a connected workshop is tracked in [#47](https://github.com/ever-guild/AgentShelf/issues/47). [architecture.md](architecture.md#booking) lists its states and errors |
| `get_order_status` | Read-only | Reads one order's stored payment status with the `statusToken` from `create_checkout` or `book_slot`, and for a booking its state, deposit and remaining balance. It never asks PayPal and never changes anything. [architecture.md](architecture.md#payment-reconciliation) explains how an order gets to each status |

A result carries `structuredContent` and the same JSON as text. A failure has `isError: true` and text with a JSON object holding a stable `code`, a `message` that is safe to show, and optional `details`. An input rejected by the schema has `isError: true` and text naming the field. A search with no match is an empty list, not an error.

## Authentication

The connector has no sign-in, because everything it offers is public:

- It only reads published catalog data, and it returns no merchant identifiers or credentials.
- A checkout or a booking only returns an approval link, and the buyer still confirms the payment in PayPal.
- An order's status needs the capability returned with that order, so an order identifier alone reveals nothing.
- Seller data is not reachable through it. Sellers use owner sessions in the browser, or separate seller MCP endpoints with an owner-issued Bearer grant, see [seller MCP](seller-agent-mcp.md). Never send a seller grant to `/mcp`.

## Origin handling

The [MCP specification](https://modelcontextprotocol.io/specification/latest/basic/transports) requires rejecting a request whose `Origin` header is present and invalid. The route answers `403` unless the origin is `https://claude.ai`, `https://chatgpt.com`, this deployment's own origin, or listed in `MCP_ALLOWED_ORIGINS`. A request with no `Origin` is allowed, which is the normal case for a client calling from its own servers. A rejected origin is written to the server log, so a real client's origin can be added through that variable without a code change.

## How it is served

Each `POST` creates its own server and transport and returns JSON. Nothing has to survive between requests, so a restart or a sleeping instance loses no state. `GET` and `DELETE` answer `405`, because the server has no server-initiated stream and no sessions. Request bodies are limited to 64 KiB.

## Connect Claude

**Not tested in claude.ai.** These steps follow [Add a connector that isn't in the directory](https://claude.com/docs/connectors/custom/remote-mcp). Claude connects from Anthropic's cloud, so the URL must be publicly reachable over HTTPS.

1. Go to **Customize > Connectors** and click **Add custom connector**. On Team and Enterprise plans, an Owner adds it under **Organization settings > Connectors**. The Free plan allows one custom connector.
2. Enter `https://agentshelf-e5bk.onrender.com/mcp`.
3. If asked about authentication, choose **No sign-in**.
4. In a chat, turn the connector on from **+ > Connectors**, then ask for something like "find an iPhone 13 screen protector in Liepaja under 15 euros".

Claude's documented limits are about 150,000 characters per tool result and 240 seconds per tool call.

### Claude Code

Claude Code 2.1.319 connected to the deployed `/mcp` with this entry and listed the five tools; no buyer tool was called through it. The buyer connector needs no header. Do not reuse a seller grant here.

```json
{
  "mcpServers": {
    "agentshelf": { "type": "http", "url": "https://agentshelf-e5bk.onrender.com/mcp" }
  }
}
```

```sh
claude --mcp-config ./agentshelf-buyer.json --strict-mcp-config
```

## Connect ChatGPT

**Not tested.** No ChatGPT session has connected to this server, and a pass in Claude Code, the MCP Inspector or an SDK client is not evidence for ChatGPT. These steps follow [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt). Account and workspace policies can restrict custom servers.

1. Go to [ChatGPT Plugins](https://chatgpt.com/plugins), select the plus button, then **Add custom MCP server**.
2. Enter a name and description, and under **Connection** enter `https://agentshelf-e5bk.onrender.com/mcp`.
3. Set authentication to **No authentication**, review the warning and confirm, then select **Create as a plugin**.
4. Review the discovered tools. In a new conversation, type `@`, select the plugin and ask the same question.
5. After a server change, select **Refresh** on the connection and start a new conversation.

[ChatGPT honours `readOnlyHint`](https://developers.openai.com/api/docs/guides/custom-mcp-server): it treats a tool without that hint as a write action, and write actions require confirmation by default. `search_products`, `get_slots` and `get_order_status` are marked read-only, `create_checkout` and `book_slot` are marked as writes.

Only the buyer connector is offered to ChatGPT. Seller MCP needs a Bearer header, which the documented ChatGPT setup does not provide.

## Smoke check

The bundled scripts check the **seeded demo shops**. They use the fixed demo product, shop and service UUIDs, and the payment scripts use the legacy `PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP` app. They are not a check for a shop an owner registered and connected through the PayPal platform. See [what each script assumes](../DEVELOP.md#what-the-smoke-scripts-can-check).

This one never sends a valid checkout, so it cannot create an order:

```bash
npm run smoke:mcp -- https://YOUR-SERVICE.onrender.com/mcp
```

Each line reports `PASS` or `FAIL`, and the command exits with an error if any check fails.

The legacy direct-merchant diagnostics below create real Sandbox orders and need the legacy demo shop's PayPal app in `.env.local`. They report `BLOCKED` and exit with 2 rather than passing a check they could not run. With `--wait`, they wait up to ten minutes for a person to approve in PayPal as the sandbox buyer. `smoke:checkout` passes once `get_order_status` reports `paid`; `smoke:booking` holds a seeded repair slot for 15 minutes and passes once the deposit is `paid` and the booking `confirmed`.

```bash
npm run smoke:checkout -- https://YOUR-SERVICE.onrender.com/mcp --wait
npm run smoke:booking -- https://YOUR-SERVICE.onrender.com/mcp --wait
```

## Check a connected shop

For a shop whose owner connected PayPal through the platform, call the existing tools directly. No runner exists for this; each step is one JSON-RPC `tools/call` on `/mcp`, or one assistant request.

1. `search_products` with words from the shop's published product. Note `productId`, `shopId`, `availability` and `matching.mode`.
2. `create_checkout` with `{"items":[{"productId":"…","quantity":1}],"idempotencyKey":"<new UUID>"}`. Expect an approval link and a `statusToken`. Repeating the same key returns the same order. A product without a stock decision or without available units answers `PRODUCT_UNAVAILABLE`.
3. A person opens the approval link and approves as the Sandbox buyer. Nothing is charged without that step.
4. `get_order_status` with `orderId` and `statusToken` until it reports `paid`. It reads stored state only; webhooks, the buyer's return and the sweep move the order.
5. In the seller catalog, available stock has dropped by one.

For a booking, use `get_slots` with the shop's `shopId`, the repair's `serviceId` and a `from`/`to` window, then `book_slot` with the returned `slotId`. This needs a technician with working hours on the shop, see [#47](https://github.com/ever-guild/AgentShelf/issues/47).

Example request for step 1:

```bash
curl -s https://YOUR-SERVICE.onrender.com/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_products","arguments":{"query":"screen protector"}}}'
```
