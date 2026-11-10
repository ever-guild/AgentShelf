# MCP connector

One remote connector covering all shops, for [#5](https://github.com/ever-guild/AgentShelf/issues/5). The endpoint is `POST /mcp` over Streamable HTTP, with the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

> [!TIP]
> For assistant connection instructions (claude.ai, Claude Code, and ChatGPT) with verified prompts, the 4-step purchase cycle, and environment limitations, see [AgentShelf Buyer Quickstart](buyer-quickstart.md).

## Status

A client is marked working only after a real connection to it. Each row is separate evidence: a script, an SDK client or one assistant does not stand in for another. Levels are defined in [capabilities.md](capabilities.md#evidence-levels).

| Check | Level | Result |
| --- | --- | --- |
| `smoke:mcp` and `smoke:demo` against a local production build with the fixture seed | `locally tested` | **PASS** on 9 November 2026 at `37fea91`: initialize, list tools, search both demo shops, reject bad input, free repair slots. `create_checkout` on a fixture shop answered `PAYMENT_NOT_CONFIGURED` and created no order |
| Direct HTTPS JSON-RPC call to the deployed `/mcp` for a PayPal-connected shop | `live/mutating rehearsal verified` (dated hosted helper-script run, no external client); PayPal Sandbox evidence: order approved by a person | **PASS** on 8 November 2026: one `create_checkout` for EUR 1, approved in PayPal Sandbox by a person, captured for the right seller, and `get_order_status` reported `paid`, see [proof #2](https://github.com/ever-guild/AgentShelf/issues/2). This was a mutating helper-script run, not an assistant |
| Claude Code CLI with an `http` server entry for the deployed `/mcp` | `external client verified` (Claude Code only) | Connected and listed the five tools on 8 November 2026; no buyer tool was called |
| Claude Code 2.1.282 with claude-opus-5-5 as the buyer through the public `/mcp` connector | `external client verified` (Claude Code only) | 9 November 2026, 20:51-20:52 UTC: `search_products`, `create_checkout`, a person approved 9.90 EUR as the Sandbox buyer, order `paid`, stock 2 to 1, see [#18 closing checks](https://github.com/ever-guild/AgentShelf/issues/18#issuecomment-6751202970). Claude Code is a CLI client, not claude.ai or ChatGPT |
| Hosted release rehearsals on `d908114` | `live/mutating rehearsal verified`; PayPal Sandbox captures | 9 November 2026: read-only searches and slot listing plus state-changing `book_slot`, a 20 EUR deposit approved and captured, a 9.90 EUR order paid, stock 4 to 3 to 2. See [#18 rehearsal 1](https://github.com/ever-guild/AgentShelf/issues/18#issuecomment-6750920042) and [rehearsals 2 and 3](https://github.com/ever-guild/AgentShelf/issues/18#issuecomment-6751024359) |
| Read-only check of the hosted service at `198bc1f` | `live/read-only verified` | 10 November 2026, 03:51-03:52 UTC, plain HTTP without an `Origin` header: `GET /api/health` 200 with commit `198bc1f`; `GET /api/health/ready` 200 `ready`; `tools/list` 200 with the five tools; one `search_products` ("iPhone 13 screen protector", Liepaja) 200 with 2 available products, `matching.mode` `full`; one `get_slots` for the demo repair service, 11-13 November, 200 with 68 slots, `truncated: false`, Europe/Riga. No booking, checkout, order or payment was created. It does not show that claude.ai or ChatGPT work |
| Claude custom connector (claude.ai) | `not tested` | No session has connected. Minimal manual step: the repository owner or a teammate with a claude.ai plan that allows custom connectors follows [Connect Claude](#connect-claude), runs a read-only search, and records client, plan type, date, commit and result. A payment run also needs the human Sandbox buyer |
| ChatGPT | `not tested` | No session has connected. Minimal manual step: the repository owner or a teammate with a ChatGPT plan that allows custom MCP connectors follows [Connect ChatGPT](#connect-chatgpt), runs a read-only search, and records client, plan type, date, commit and result. A payment run also needs the human Sandbox buyer |

## Tools

The schemas are in [`src/server/contracts/commerce.ts`](../src/server/contracts/commerce.ts). Inputs are strict, so a request carrying a total, a price, a merchant or any other unknown field is rejected.

| Tool | Kind | State |
| --- | --- | --- |
| `search_products` | Read-only for the caller | Works across all shops, in English, Latvian and Russian, with deterministic matching and no model call. Records each search as demand, and reports `matching.mode`. See [Search](architecture.md#search) |
| `create_checkout` | Write | Reserves stock and creates a PayPal sandbox order from the stored cart, then returns its approval link, which is not payment. A shop needs a ready PayPal connection, or legacy demo credentials, otherwise the answer is `PAYMENT_NOT_CONFIGURED` and no order is created. A physical product also needs an explicit stock policy and available units, otherwise `PRODUCT_UNAVAILABLE`. [architecture.md](architecture.md#checkout) lists its errors and when to retry |
| `get_slots` | Read-only | Lists free appointment times for a service, with exact instants, the shop's timezone and the technician. At most 100 per answer, and `truncated` says when there are more |
| `book_slot` | Write | Holds a slot for 15 minutes and creates a PayPal sandbox order for the service's deposit, and returns its approval link, which is not payment. The booking is confirmed only after a verified capture. Slots exist only for a shop with a technician and working hours, set up on `/seller/schedule`. The shop must be payment-ready, otherwise booking answers `PAYMENT_NOT_CONFIGURED`. A 20 EUR Sandbox deposit was approved and captured in the 9 November rehearsals ([#18](https://github.com/ever-guild/AgentShelf/issues/18#issuecomment-6751024359)); booking setup for a connected workshop is tracked in [#47](https://github.com/ever-guild/AgentShelf/issues/47). [architecture.md](architecture.md#booking) lists its states and errors |
| `get_order_status` | Read-only | Reads one order's stored payment status with the `statusToken` from `create_checkout` or `book_slot`, and for a booking its state, deposit and remaining balance. It never asks PayPal and never changes anything. [architecture.md](architecture.md#payment-reconciliation) explains how an order gets to each status |

A result carries `structuredContent` and the same JSON as text. A failure has `isError: true` and text with a JSON object holding a stable `code`, a `message` that is safe to show, and optional `details`. An input rejected by the schema has `isError: true` and text naming the field. A search with no match is an empty list, not an error.

## Authentication and route boundaries

The buyer connector at `POST /mcp` has no sign-in, because everything it offers is public:

- It only reads published catalog data, and it returns no merchant identifiers or credentials.
- A checkout or a booking only returns an approval link, and the buyer still confirms the payment in PayPal.
- An order's status needs the capability returned with that order, so an order identifier alone reveals nothing.
- Seller data is not reachable through it.

### Boundary with Seller MCP

Buyer MCP and Seller MCP are strictly separated:
- **Public Buyer MCP (`POST /mcp`)**: Public, no authentication, 5 commerce tools (`search_products`, `get_slots`, `book_slot`, `create_checkout`, `get_order_status`). Available to any AI assistant or buyer client.
- **Protected Seller MCP (`POST /mcp/seller/onboarding` and `POST /mcp/seller/shop/{shopId}`)**: Protected by an owner-issued Bearer grant token with fine-grained scopes (`create_shop`, `manage_catalog`, `manage_inventory`, `connect_paypal`). Used exclusively for shop onboarding, catalog imports/reviews, stock level updates, and PayPal seller onboarding. See [seller MCP](seller-agent-mcp.md).

Never send a seller grant to `/mcp`, and never offer seller endpoints to public buyer assistants.

## Origin handling

The [MCP specification](https://modelcontextprotocol.io/specification/latest/basic/transports) requires rejecting a request whose `Origin` header is present and invalid. The route answers `403` unless the origin is `https://claude.ai`, `https://chatgpt.com`, this deployment's own origin, or listed in `MCP_ALLOWED_ORIGINS`. A request with no `Origin` is allowed, which is the normal case for a client calling from its own servers. A rejected origin is written to the server log, so a real client's origin can be added through that variable without a code change.

## How it is served

Each `POST` creates its own server and transport and returns JSON. Nothing has to survive between requests, so a restart or a sleeping instance loses no state. `GET` and `DELETE` answer `405`, because the server has no server-initiated stream and no sessions. Request bodies are limited to 64 KiB.

## Connect Claude

**Not tested in claude.ai.** These steps follow Anthropic's [custom remote connector instructions](https://claude.com/docs/connectors/custom/add-unlisted). Claude connects from Anthropic's cloud, so the URL must be publicly reachable over HTTPS. For setup and safe sample prompts, see [AgentShelf Buyer Quickstart](buyer-quickstart.md).

1. Go to **Customize > Connectors** and click **Add custom connector**. On Team and Enterprise plans, an Owner adds it under **Organization settings > Connectors**. The Free plan allows one custom connector.
2. Enter `https://agentshelf-e5bk.onrender.com/mcp`.
3. If asked about authentication, choose **No sign-in**.
4. In a chat, turn the connector on from **+ > Connectors**, then ask for something like "find an iPhone 13 screen protector in Liepaja under 15 euros".

Claude's documented limits are about 150,000 characters per tool result and 240 seconds per tool call.

### Claude Code

Claude Code 2.1.319 connected to the deployed `/mcp` with this entry and listed the five tools on 8 November 2026, and Claude Code 2.1.282 ran a paid buyer flow through it on 9 November 2026 (see Status). The buyer connector needs no header. Do not reuse a seller grant here.

Add via the CLI:

```bash
claude mcp add --scope user --transport http AgentShelf https://agentshelf-e5bk.onrender.com/mcp
```

Or configure via JSON:

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

**Not tested.** No ChatGPT session has connected to this server, and a pass in Claude Code, the MCP Inspector or an SDK client is not evidence for ChatGPT. These steps follow [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt) and [Custom MCP server guide](https://developers.openai.com/api/docs/guides/custom-mcp-server). Account and workspace policies can restrict custom servers. For end-to-end setup, verified prompts, and the 4-step purchase flow, see [AgentShelf Buyer Quickstart](buyer-quickstart.md).

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), click **+**, then choose **Add custom MCP server**.
2. Set the name to **AgentShelf Buyer** and the connection URL to `https://agentshelf-e5bk.onrender.com/mcp`. Choose **No authentication**.
3. Review the security notice, choose **Create as a plugin**, then select **Install plugin**.
4. Start a new conversation, type `@`, select the installed AgentShelf Buyer plugin and try the read-only search prompt in [Buyer Quickstart](buyer-quickstart.md).
5. After a server change, select **Refresh** on the connection and start a new conversation.

Vendor documentation, not tested here: [ChatGPT honours `readOnlyHint`](https://developers.openai.com/api/docs/guides/custom-mcp-server) and treats a tool without that hint as a write action, and write actions require confirmation by default. `search_products`, `get_slots` and `get_order_status` are marked read-only, `create_checkout` and `book_slot` are marked as writes.

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
