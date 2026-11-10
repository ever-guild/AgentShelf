# AgentShelf Buyer Quickstart

AgentShelf exposes a public buyer MCP connector at `https://<origin>/mcp`. It uses HTTPS and requires no authentication. Use the production origin shown in the app; account or workspace policy may restrict remote connectors.

## Connect claude.ai

1. In Claude, open **Customize > Connectors** and choose **Add custom connector**. A Team or Enterprise organization owner may need to add it in **Organization settings > Connectors**.
2. Enter **AgentShelf Buyer** and `https://<origin>/mcp`. Choose **No sign-in** if asked for authentication.
3. Start a chat, click **+ > Connectors**, and enable AgentShelf Buyer.

See Anthropic's [custom remote connector instructions](https://claude.com/docs/connectors/custom/add-unlisted). Availability depends on account and workspace settings.

## Connect ChatGPT

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), click **+**, then choose **Add custom MCP server**.
2. Name it **AgentShelf Buyer**, set its connection URL to `https://<origin>/mcp`, and choose **No authentication**.
3. Review the security notice, choose **Create as a plugin**, and select **Install plugin**.
4. Start a new chat, type `@`, and select the installed AgentShelf Buyer plugin.

The account or workspace must allow custom MCP servers. See OpenAI's [setup guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) and [custom MCP server guide](https://developers.openai.com/api/docs/guides/custom-mcp-server).

## Connect Claude Code

```bash
claude mcp add --scope user --transport http AgentShelf https://<origin>/mcp
```

## Connect another agent

Any agent that can use a remote MCP server connects the same way: add a server over Streamable HTTP with `https://<origin>/mcp` and no authentication. Many agents read an entry like this from their settings:

```json
{
  "mcpServers": {
    "agentshelf": { "type": "http", "url": "https://<origin>/mcp" }
  }
}
```

The server lists `search_products`, `get_slots`, `book_slot`, `create_checkout` and `get_order_status`. Only the clients in [MCP status](mcp.md#status) have been tested; the key names in the settings entry vary between agents.

## Try the read-only search

```text
Use only AgentShelf Buyer and call search_products to find an iPhone 13 screen protector in Liepaja. Do not use web search or tools outside AgentShelf Buyer, and do not book, order, or pay.
```

The assistant should show matching catalog results and stop. This prompt is a test instruction, not evidence that a particular external client has connected; client-specific results are tracked in [MCP status](mcp.md#status).

## Optional Sandbox checkout

Use this only when you intend to test a checkout and can approve it yourself in PayPal Sandbox:

```text
Use only AgentShelf Buyer. First call search_products for an iPhone 13 tempered glass at Liepāja Phone Workshop and show me the current available item, availability, price, and currency. If the result is ambiguous or the current price differs from a price I previously approved, ask me to confirm before checkout. Once I choose a current result, call create_checkout exactly once for that product and quantity 1, then give me its PayPal Sandbox approval link. Do not use web search or tools outside AgentShelf Buyer, do not automatically repeat or create another checkout while payment is pending, and do not claim payment is complete until get_order_status reports paid. After I return from PayPal, check order status.
```

`create_checkout` reserves available stock and returns an approval link; it does not complete payment. Review the merchant and current total in PayPal Sandbox and approve it as a human buyer. A checkout is complete only when `get_order_status` reports `paid`. If its state is pending or unclear, do not create another checkout; wait for reconciliation or ask the operator to check it.

## Repair appointments

For repairs, use `get_slots`, choose a returned slot, then call `book_slot` once. It holds the slot and returns a Sandbox deposit approval link. A human must approve the deposit in PayPal; the booking is confirmed only after verified capture. Do not use `create_checkout` for services.

## Available buyer tools

- `search_products` – read published product catalog and availability
- `get_slots` – list available repair appointments
- `book_slot` – hold a repair slot and create a deposit checkout
- `create_checkout` – reserve product stock and create a checkout
- `get_order_status` – read the state of an existing order or booking

The buyer connector is public and does not provide access to seller controls or credentials. Do not send seller grants to it.
