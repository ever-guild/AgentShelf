# MCP connector

One remote connector covering all shops, for [#5](https://github.com/ever-guild/AgentShelf/issues/5). The endpoint is `POST /mcp` over Streamable HTTP, with the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

## Status

A client is marked working only after a real connection to it.

| Check | Result |
| --- | --- |
| SDK client over HTTP against a local production build | **PASS**: initialize, list tools, find the seeded product, reject bad input |
| SDK client over HTTPS from outside | **PASS** for initialize, list tools and rejecting bad input. **BLOCKED** for finding the seeded product, because the deployed database is [not seeded yet](deployment.md#seed-the-demo-data) |
| Claude | **Not tested**: needs the seeded database |
| ChatGPT | **Not tested**: needs the seeded database |

## Tools

The schemas are in [`src/server/contracts/commerce.ts`](../src/server/contracts/commerce.ts). Inputs are strict, so a request carrying a total, a price, a merchant or any other unknown field is rejected.

| Tool | Kind | State |
| --- | --- | --- |
| `search_products` | Read-only for the caller | Works across all shops, in English, Latvian and Russian, with deterministic matching and no model call. Records each search as demand, and reports `matching.mode`. See [Search](architecture.md#search) |
| `create_checkout` | Write | Creates a PayPal sandbox order from the stored cart and returns its approval link, which is not payment. It returns `PAYMENT_NOT_CONFIGURED` for a shop without sandbox credentials, which is every shop until [#33](https://github.com/ever-guild/AgentShelf/issues/33) provides them. [architecture.md](architecture.md#checkout) lists its errors and when to retry |
| `get_slots` | Read-only | Lists free appointment times for a service, with exact instants, the shop's timezone and the technician. At most 100 per answer, and `truncated` says when there are more |
| `book_slot` | Write | Holds a slot for 15 minutes and creates a PayPal sandbox order for the service's deposit, and returns its approval link, which is not payment. The booking is confirmed only after a verified capture. It returns `PAYMENT_NOT_CONFIGURED` until [#33](https://github.com/ever-guild/AgentShelf/issues/33) provides credentials. [architecture.md](architecture.md#booking) lists its states and errors |
| `get_order_status` | Read-only | Reads one order's stored payment status with the `statusToken` from `create_checkout` or `book_slot`, and for a booking its state, deposit and remaining balance. It never asks PayPal and never changes anything. [architecture.md](architecture.md#payment-reconciliation) explains how an order gets to each status |

A result carries `structuredContent` and the same JSON as text. A failure has `isError: true` and text with a JSON object holding a stable `code`, a `message` that is safe to show, and optional `details`. An input rejected by the schema has `isError: true` and text naming the field. A search with no match is an empty list, not an error.

## Authentication

The connector has no sign-in, because everything it offers is public:

- It only reads published catalog data, and it returns no merchant identifiers or credentials.
- A checkout or a booking only returns an approval link, and the buyer still confirms the payment in PayPal.
- An order's status needs the capability returned with that order, so an order identifier alone reveals nothing.
- Seller data is not reachable through it. Seller routes use their own [demo session](architecture.md#seller-demo-session).

## Origin handling

The [MCP specification](https://modelcontextprotocol.io/specification/latest/basic/transports) requires rejecting a request whose `Origin` header is present and invalid. The route answers `403` unless the origin is `https://claude.ai`, `https://chatgpt.com`, this deployment's own origin, or listed in `MCP_ALLOWED_ORIGINS`. A request with no `Origin` is allowed, which is the normal case for a client calling from its own servers. A rejected origin is written to the server log, so a real client's origin can be added through that variable without a code change.

## How it is served

Each `POST` creates its own server and transport and returns JSON. Nothing has to survive between requests, so a restart or a sleeping instance loses no state. `GET` and `DELETE` answer `405`, because the server has no server-initiated stream and no sessions. Request bodies are limited to 64 KiB.

## Connect Claude

Follow [Add a connector that isn't in the directory](https://claude.com/docs/connectors/custom/remote-mcp). Claude connects from Anthropic's cloud, so the URL must be publicly reachable over HTTPS.

1. Go to **Customize > Connectors** and click **Add custom connector**. On Team and Enterprise plans, an Owner adds it under **Organization settings > Connectors**. The Free plan allows one custom connector.
2. Enter `https://agentshelf-e5bk.onrender.com/mcp`.
3. If asked about authentication, choose **No sign-in**.
4. In a chat, turn the connector on from **+ > Connectors**, then ask for something like "find an iPhone 13 screen protector in Liepaja under 15 euros".

Claude's documented limits are about 150,000 characters per tool result and 240 seconds per tool call.

## Connect ChatGPT

Follow [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt). Account and workspace policies can restrict custom servers.

1. Go to [ChatGPT Plugins](https://chatgpt.com/plugins), select the plus button, then **Add custom MCP server**.
2. Enter a name and description, and under **Connection** enter `https://agentshelf-e5bk.onrender.com/mcp`.
3. Set authentication to **No authentication**, review the warning and confirm, then select **Create as a plugin**.
4. Review the discovered tools. In a new conversation, type `@`, select the plugin and ask the same question.
5. After a server change, select **Refresh** on the connection and start a new conversation.

[ChatGPT honours `readOnlyHint`](https://developers.openai.com/api/docs/guides/custom-mcp-server): it treats a tool without that hint as a write action, and write actions require confirmation by default. `create_checkout` and `book_slot` are marked as writes.

## Smoke check

This runs against any deployment with the demo data seeded. It never sends a valid checkout, so it cannot create an order.

```bash
npm run smoke:mcp -- https://YOUR-SERVICE.onrender.com/mcp
```

Each line reports `PASS` or `FAIL`, and the command exits with an error if any check fails.

To check the checkout itself once a shop has sandbox credentials, run the following. It leaves one unpaid sandbox order behind and prints its private approval link. It checks that repeating the key returns the same order, and reads the recipient and amount back from PayPal using the seller's credentials in `.env.local`. It reports `BLOCKED` and exits with 2 rather than passing a check it could not run.

With `--wait`, it then waits up to ten minutes for a person to approve in PayPal as the sandbox buyer, and passes only once `get_order_status` reports `paid`. That is one complete real purchase through the connector.

```bash
npm run smoke:checkout -- https://YOUR-SERVICE.onrender.com/mcp --wait
```

To check a booking the same way, run the following. It holds one real slot on the seeded repair for 15 minutes and creates one unpaid sandbox deposit order. With `--wait`, it passes only once `get_order_status` reports the deposit `paid` and the booking `confirmed`.

```bash
npm run smoke:booking -- https://YOUR-SERVICE.onrender.com/mcp --wait
```
