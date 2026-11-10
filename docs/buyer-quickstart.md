# AgentShelf Buyer Quickstart: Connect Claude & ChatGPT

Connect Claude (claude.ai, Claude Code) and ChatGPT to AgentShelf's remote buyer MCP connector. This guide covers setup, verified prompts, the 4-step purchase flow, service booking, and environment limitations.

The buyer connector is a public Streamable HTTP MCP endpoint at `POST /mcp` covering all published merchant catalogs. It requires no API keys or user sign-in.

---

## Official vendor specifications (checked November 2026)

- **Anthropic**: [Add a connector that isn't in the directory](https://claude.com/docs/connectors/custom/remote-mcp) (claude.ai custom remote MCP connector documentation).
- **OpenAI**: [Custom MCP server guide](https://developers.openai.com/api/docs/guides/custom-mcp-server) and [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt) (OpenAI ChatGPT custom MCP server documentation).

---

## Connection instructions

Replace `<origin>` with your hosted deployment domain (e.g., `agentshelf-e5bk.onrender.com`). The endpoint must be publicly accessible over HTTPS.

### 1. Claude on the web (claude.ai)

1. Open **claude.ai**, click your profile or organization icon, and navigate to **Customize > Connectors** (or **Organization settings > Connectors** on Team and Enterprise plans).
2. Click **Add custom connector**.
3. Fill in the connection settings:
   - **Name**: `AgentShelf Buyer`
   - **Remote MCP server URL**: `https://<origin>/mcp`
   - **Authentication**: Select **No sign-in**. (The buyer connector is public; never provide seller grants or API credentials here).
4. Save the connector. Claude will inspect the endpoint and discover the 5 buyer tools:
   - `search_products` (read-only)
   - `get_slots` (read-only)
   - `book_slot` (write)
   - `create_checkout` (write)
   - `get_order_status` (read-only)
5. In any new chat, click the **+** button next to the message input, select **Connectors**, and ensure **AgentShelf Buyer** is turned on.

### 2. Claude Code CLI

Connect Claude Code directly using the CLI command:

```bash
claude mcp add --scope user --transport http AgentShelf https://<origin>/mcp
```

Or add the server configuration to your MCP config file (e.g., `~/.claude/settings.json` or `./agentshelf-buyer.json`):

```json
{
  "mcpServers": {
    "AgentShelf": {
      "type": "http",
      "url": "https://<origin>/mcp"
    }
  }
}
```

Launch Claude Code with:

```bash
claude --mcp-config ./agentshelf-buyer.json --strict-mcp-config
```

### 3. ChatGPT (chatgpt.com)

1. Ensure your ChatGPT account/workspace has developer mode or custom MCP server access enabled.
2. Go to **Settings > Apps** / **Developer Mode**, or open [ChatGPT Plugins](https://chatgpt.com/plugins) and click the **+** button, then select **Add custom MCP server**.
3. Fill in the server parameters:
   - **Name**: `AgentShelf Buyer`
   - **Connection URL**: `https://<origin>/mcp`
   - **Authentication**: Select **No authentication**.
4. Confirm any security notices and select **Create as a plugin** / **Install plugin**. ChatGPT will register the 5 buyer tools.
5. In a new conversation, reference `@AgentShelf` or select the plugin from the tools dropdown.

---

## Verified prompts

### Prompt A: Read-only search (catalog lookup)

Use this prompt to verify connectivity and search without triggering any purchases or slot reservations:

```text
Find an iPhone 13 screen protector in Liepaja. Use only AgentShelf Buyer; do not search the web or book/order.
```

**Expected behavior**: The assistant calls `search_products` with `query: "iPhone 13 screen protector"` and `location: "Liepaja"`. It presents matching products with prices, merchant name, and current stock availability, then stops without placing orders.

### Prompt B: Deliberate Sandbox purchase (end-to-end checkout)

Use this prompt when you intend to test the complete PayPal Sandbox order creation:

```text
I want to buy the tempered glass for iPhone 13 from Liepāja Phone Workshop for €9.90. Please call create_checkout on AgentShelf Buyer to get my PayPal Sandbox payment link.
```

**Expected behavior**: The assistant searches the catalog (or reuses recent search results) to obtain the live `productId`, then calls `create_checkout` with `{ "items": [{ "productId": "<productId>", "quantity": 1 }], "idempotencyKey": "<uuid>" }`. The assistant returns the generated PayPal Sandbox approval link to you.

---

## The 4-step physical product purchasing flow

Agentic commerce in AgentShelf strictly preserves buyer consent. An AI assistant prepares and tracks the order, but human authorization is required before any money moves.

```
+-----------------------------------------------------------------------------------+
| 1. Search (Assistant)  -> search_products returns live productId, shopId, stock    |
| 2. Checkout (Assistant)-> create_checkout reserves stock & returns PayPal URL     |
| 3. Approval (Human)    -> Buyer signs into PayPal Sandbox and approves payment   |
| 4. Status (Assistant)  -> get_order_status polls status until 'paid'               |
+-----------------------------------------------------------------------------------+
```

### Step 1: Search products (`search_products`)
The assistant searches published catalogs across all shops:
- Identifiers (`productId`, `shopId`) are dynamic and must come from live search results. Do not hardcode static IDs.
- Confirms the item is in stock (`availability: "available"`). If a merchant has not set stock or available units are 0, checkout will be rejected.

### Step 2: Create checkout (`create_checkout`)
The assistant initiates order creation:
- The tool accepts `{ items: [{ productId, quantity }], idempotencyKey }`.
- AgentShelf reserves available inventory and calls PayPal Orders v2 on behalf of the connected merchant.
- The tool returns:
  - `approvalUrl`: PayPal Sandbox approval link.
  - `orderId`: AgentShelf internal order ID.
  - `statusToken`: Opaque capability token required to query order status.
- **Important**: The approval link is **not** payment. It represents a pending authorization session. No funds have been transferred.

### Step 3: Human confirmation in PayPal Sandbox
The human buyer completes the payment:
- The user opens the `approvalUrl` in a browser.
- The user logs in using a PayPal Sandbox Personal buyer account.
- The user reviews the merchant name and total amount (€9.90), then clicks **Continue** / **Complete Purchase**.
- AI agents never hold buyer credit card data or PayPal passwords, and cannot bypass this manual step.

### Step 4: Order status reconciliation (`get_order_status`)
The assistant confirms the transaction:
- The assistant calls `get_order_status` with `orderId` and `statusToken`.
- When PayPal webhooks or buyer redirect trigger capture on the backend, the order transitions from `created` to `paid`.
- Available stock on the merchant's shelf decreases by the purchased quantity.
- The assistant informs the user that the purchase is complete.

---

## Services and appointments (repairs)

Services such as smartphone screen repairs or diagnostics operate under a different workflow:

- **Services cannot be bought through `create_checkout`**. Calling `create_checkout` on a service item will fail because services require a designated technician and schedule slot.
- **Service booking workflow**:
  1. **Find slots**: Assistant calls `get_slots` with `shopId`, `serviceId`, and a datetime window (`from` and `to`).
  2. **Hold slot & book**: Assistant calls `book_slot` with `slotId`, customer contact information, and an `idempotencyKey`. This temporarily holds the slot for 15 minutes and returns a PayPal Sandbox deposit approval link (e.g., €20 deposit).
  3. **Human deposit payment**: The buyer opens the deposit approval link and authorizes the deposit in PayPal Sandbox.
  4. **Confirmation**: Once captured, `get_order_status` reports the booking state as `confirmed`, showing the paid deposit and remaining balance due in-shop.

---

## Client and environment boundaries

Keep these environment constraints in mind when testing:

1. **Public HTTPS requirement**: Anthropic and OpenAI servers reach MCP connectors from their cloud data centers. Local hostnames (`localhost`, `127.0.0.1`) and plain HTTP are not reachable without a public HTTPS tunnel or deployed cloud URL.
2. **Account tier and policy**: Custom remote MCP server integration in ChatGPT or Claude may require a specific plan (e.g. Claude Pro/Team/Enterprise, ChatGPT Plus/Team/Enterprise) or admin workspace authorization.
3. **Write actions and human-in-the-loop prompts**:
   - `search_products`, `get_slots`, and `get_order_status` are read-only operations (`readOnlyHint: true`).
   - `create_checkout` and `book_slot` are mutating write operations (`readOnlyHint: false`).
   - Assistant interfaces (ChatGPT and Claude) may display a prompt asking the user to confirm before calling a write action. This is normal security behavior.
   - If a prompt explicitly commands "Search only; do not book, order, or pay", the LLM will deliberately refrain from calling `create_checkout`. To test checkout, use Prompt B.
4. **PayPal Sandbox environment**: All payments occur inside the PayPal Sandbox. No real money or live cards are processed.
