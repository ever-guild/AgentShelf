# AgentShelf

AgentShelf lets small shops and local workshops publish an AI-accessible catalog, take repair bookings, and accept payments directly into the seller's PayPal account in the PayPal Sandbox. Buyers discover offerings and initiate checkout through their autonomous AI assistants or the public storefront, with every purchase confirmed by a human in PayPal.

**Live demo:** [agentshelf-e5bk.onrender.com](https://agentshelf-e5bk.onrender.com) · [Capabilities & proof matrix](docs/capabilities.md) · [Buyer quickstart](docs/buyer-quickstart.md) · [Buyer MCP setup](docs/mcp.md) · [Deployment guide](docs/deployment.md)

[Privacy policy](https://agentshelf-e5bk.onrender.com/privacy) · [User agreement](https://agentshelf-e5bk.onrender.com/terms)

---

## Quick walkthrough for shop owners

```
Owner Sign-in / Register ──▶ Connect PayPal Merchant ──▶ Import Price List (CSV / Photo)
                                                                 │
                                                                 ▼
Buyer Checkout / MCP ◀── Configure Stock Policy ◀── Review & Publish to Catalog
```

1. **Sign in or register:**
   - The **Sign in** link on the home page opens the shop access-code form. Use **Sign in with an owner account** or **Register a shop** below it, or go straight to [owner sign-in](https://agentshelf-e5bk.onrender.com/seller/owner-sign-in) (**Log in with PayPal**, or username and password under **Other sign-in options**) or [Register](https://agentshelf-e5bk.onrender.com/seller/register).
   - Enter your shop details (name, currency, timezone, location), then select the shop. You land on `/seller/assistant`.
2. **Connect your PayPal merchant account:**
   - Navigate to `/seller/paypal-connection` to grant AgentShelf platform permission to route customer payments directly to your PayPal account.
   - For architecture and verification status, see [PayPal platform setup](docs/paypal-platform-setup.md) and [Sandbox proof](docs/paypal-sandbox-proof.md).
3. **Import your price list:**
   - Open `/seller/imports` to upload a CSV file or price-list image.
   - CSV parsing is fully deterministic and requires no AI credentials. Photo recognition uses the server-configured AI provider.
4. **Review and publish:**
   - Review imported rows on `/seller/imports/[id]`, correct titles, prices, categories, or deposit amounts, and click **Publish**.
5. **Optional product reference lookup:** In `/seller/catalog`, request Channel3 reference specifications and retailer offers, then check the source and choose whether to apply a same-currency price. Results are heuristic suggestions, not exact SKU verification. See [Channel3 catalog suggestions](docs/channel3.md).
6. **Set physical inventory stock policy:**
   - Open `/seller/catalog`. Newly published physical products are marked **Stock decision required** and fail closed on checkout until a policy is configured.
   - Choose **Track quantity** (enter on-hand units $\ge 0$) or **Do not track quantity** (untracked mode). Quantities can be adjusted at any time with versioned conflict protection.
7. **Configure workshop schedule (services):**
   - For repair and appointment services, open `/seller/schedule` to configure technicians and working hours. Bookings appear automatically in the Bryntum Scheduler.
8. **Optional: work through your own assistant.** `/seller/assistant` (first item in the seller menu) shows the shop's seller MCP address and the three steps: issue a credential in `/seller/agent-access`, connect your agent to that address, ask in plain words. This is separate from the **Demand assistant** panel on `/seller/dashboard`, which is the built-in AG Studio assistant for questions about demand and cannot change the shop.

---

## AI Agent Integrations

AgentShelf provides two dedicated Model Context Protocol (MCP) surfaces over Streamable HTTP:

### 1. Buyer MCP (`POST /mcp`)
A public endpoint for customer-facing assistants (e.g., Claude, ChatGPT) to discover items and create orders across shops without authentication:
- `search_products`: Multi-language SQL full-text search over published listings and AI-indexed search terms, respecting stock availability.
- `get_slots`: Find available appointment slots for service listings.
- `book_slot`: Reserve a 15-minute slot and obtain a PayPal deposit approval URL.
- `create_checkout`: Reserve required stock and return a PayPal Orders v2 approval URL.
- `get_order_status`: Check reconciliation and payment capture status using the capabilities token.

On the home page, **Connect your assistant** leads to the connector address and the buttons **Connect Claude**, **Connect ChatGPT** and **Connect another agent**, each with three setup steps and a read-only search request. See [Buyer quickstart](docs/buyer-quickstart.md) and [Buyer MCP connector setup](docs/mcp.md) for the same instructions and the recorded client results.

### 2. Seller Agent MCP (`POST /mcp/seller/`)
A protected management surface for the shop owner's autonomous agent (such as Claude Code):
- Requires a Bearer credential issued by the owner under `/seller/agent-access` (**Review and issue credential**); the credential lasts 15 minutes and is revoked with **Revoke credential**. The owner never shares server credentials. PayPal consent is a separate owner step on `/seller/paypal-connection` (**Start sandbox connection**), or a `connect_paypal` credential the owner grants after ticking the data-sharing consent.
- Supports creating shops, importing price lists, publishing listings, setting inventory policies, and managing stock.
- Grants can be revoked by the owner at any time. See [Seller agent MCP setup](docs/seller-agent-mcp.md) and [verified rehearsal guide](docs/seller-agent-rehearsal.md).

---

## Local Development

Requires Node.js 24 and PostgreSQL 17.

```bash
npm ci
createdb agentshelf_dev
if [ ! -e .env.local ]; then cp .env.example .env.local; fi
# Configure DATABASE_URL, APP_SIGNING_SECRET and APP_ORIGIN=http://localhost:3000 in .env.local
npm run db:migrate
npm run db:seed
npm run dev
```

Open <http://localhost:3000>. Keep secrets in `.env.local` or your deployment secret store; never commit secrets to Git.

---

## Deployment and Verification Boundaries

- **Hosting:** Deployed on Render web services with managed PostgreSQL. Pushes to `main` trigger CI, which validates linting, tests, and build before invoking the Render Deploy Hook for the exact commit SHA.
- **Environment:** Operates strictly within **PayPal Sandbox**. Real credit cards, live banking, and production merchant accounts are out of scope.
- **Payments:** Payment amounts route directly to seller accounts via Orders v2 `payee`. A human buyer must log in to PayPal to approve payments; agents never charge stored payment methods directly.
- **Client verification:** The buyer MCP has recorded sessions in Claude Code, the Claude desktop app, claude.ai and ChatGPT, with dates, commits and caveats in [MCP status](docs/mcp.md#status); one ChatGPT purchase ended unpaid and a repair booking from ChatGPT is not tested. The seller MCP is verified with Claude Code CLI (2.1.319) only; claude.ai and ChatGPT cannot send its Bearer credential.

[Capabilities matrix](docs/capabilities.md) · [Developer guide](DEVELOP.md) · [Partner integrations](docs/integrations.md) · [Contribution guide](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
