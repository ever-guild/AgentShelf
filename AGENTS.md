<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AgentShelf

Open source service that makes any small shop buyable by AI agents in 5 minutes, with payment through PayPal. Built for the PayPal AI Hackathon.

- **Users:** small shops and workshops with no online store, such as Instagram sellers, local stores and repair services.
- **Seller flow:** photograph a price list, AI builds a catalog, the seller corrects it in a table and publishes. The seller then sees orders, bookings and what agents searched for but did not find.
- **Buyer flow:** the buyer's own assistant (Claude, ChatGPT) uses one MCP connector covering all shops, finds a product or a free slot, and creates an order. The buyer confirms payment in PayPal.
- **Demo shops:** a phone repair workshop (accessories and repairs) and one shop of a different type.

## Rules that must always hold

- Money goes directly to the seller. Every Orders v2 order sets `payee` to the shop's PayPal account (its test business account in sandbox).
- A human always confirms payment in PayPal. An agent creates the order and returns the approval link, and never charges anything itself.
- Sandbox only. No live credentials and no real seller onboarding (Partner Referrals).
- The repo is public. Secrets live only in environment variables: Render in production, `.env.local` locally. Add every new variable to `.env.example` with no value.
- Real customers' names, faces and data never appear in demo data or screenshots.

## Stack

- Next.js and TypeScript (App Router, `src/`), Tailwind CSS
- Postgres on Render, through Drizzle ORM (see [docs/architecture.md](docs/architecture.md))
- MCP TypeScript SDK over Streamable HTTP
- `@paypal/paypal-server-sdk` for Orders v2, `@paypal/agent-toolkit`, PayPal JS SDK v6
- Claude API (`@anthropic-ai/sdk`) for catalog import, behind one adapter. The Studio Agent Framework's provider is not chosen yet
- AG Grid / AG Studio, starting from https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate
- Bryntum Scheduler
- Render: web service, MCP server, Postgres, and Render Workflows for background price list processing

## How the flows use PayPal and AI

| Flow | PayPal | AI |
| --- | --- | --- |
| Seller onboarding | Catalog Products (`create_product`) | Vision model extracts products, prices and variants from a photo or CSV |
| Agent search and order | Orders v2 with the seller as `payee` and an approval link | Semantic search across all shops |
| After payment | Webhooks, Shipment Tracking | Seller sends a tracking number by Telegram, AI records it (optional) |
| Seller dashboard | Agent Toolkit: `list_transactions`, `create_refund`, `get_merchant_insights` | Insights on unmet agent searches, seller copilot |
| Storefront for humans | JS SDK v6, PayPal buttons | Product descriptions in English and Latvian |

MCP tools: `search_products`, `get_slots`, `book_slot`, `create_checkout`, `get_order_status`.

## Scope

**Required.** All of it must work end to end by the evening of Nov 9, 2026.

1. Onboarding: price list photo or CSV → AI extraction → table for corrections → publish to the PayPal catalog.
2. MCP server over HTTPS with the tools above, working as a connector in Claude and ChatGPT.
3. Payment: Orders v2 with seller `payee` → approval in PayPal → capture → webhook → order in the database.
4. Repair booking: technician slots, PayPal deposit, booking appears immediately in Bryntum Scheduler.
5. Seller dashboard on AG Studio: orders, bookings, agent searches, AI insights.
6. Simple storefront with PayPal buttons (JS SDK v6).
7. Deployed on Render, with 2 demo shops and a sandbox test buyer.

**Optional, in this order.** Start only once everything required works.

1. Seller copilot on Agent Toolkit ("refund order 12", "invoice Janis for the repair").
2. Channel3: product photos and specs, market price comparison.
3. "Try it" page with a chat agent, so judges can test without configuring Claude.
4. Seller notifications through Zapier, tracking numbers through Shipment Tracking.
5. WebMCP on the storefront, behind a browser support check.
6. Catalog import from a website through KERNEL.

**Out of scope:** real money, our own buyer agent as the main path, a mobile app, complex auth, full ACP and UCP support.

## Partner tools

Use these for real, because partner judges will notice superficial use.

- **AG Grid:** AG Studio with a custom theme, custom widgets and an agent in Studio Agent Framework. Plain tables are not enough.
- **Bryntum:** the buyer's agent books a slot and pays a deposit, and the booking appears in the scheduler. This is the center of the workshop demo.
- **APIMatic:** use the PayPal Context Plugin in the editor while writing PayPal code, and note this in the README.
- **Render:** all hosting, plus Workflows for background jobs.

## Working in this repo

```bash
npm run dev    # local server on http://localhost:3000
npm run lint
npm run build
npm test       # needs TEST_DATABASE_URL; npm run test:unit needs no database
npm run db:migrate
npm run db:seed
npm run smoke:mcp -- URL   # checks a running /mcp endpoint
npm run smoke:checkout -- URL [--wait]   # creates one sandbox order through a running /mcp endpoint
npm run smoke:import -- URL [FILE]   # uploads a price list to a running service and checks what was read
```

Run `npm run lint`, `npm run build` and `npm test` before pushing. [docs/architecture.md](docs/architecture.md) covers database setup, the rules the data model enforces and the shared service contracts.

- Commit and push directly to `main`, keeping each commit to one issue. [CI](.github/workflows/ci.yml) runs lint, the full test suite with an isolated Postgres and the production build; after validation, its deploy job requests Render through a Deploy Hook for the exact commit SHA and checks public health and readiness endpoints. The repository secret `RENDER_DEPLOY_HOOK_URL` must be configured before automated delivery works. Render's native auto-deploy is disabled in [render.yaml](render.yaml); to freeze publishing, disable the GitHub Actions deploy job or its publishing gate as well.
- Each area has one owner: PayPal and backend; MCP and AI search; onboarding and booking; dashboard and submission. Stay inside the area you were asked to work on, and flag changes that reach into another.
- Scope decisions belong to the team captain, so ask rather than adding features.
- Write UI text, code, comments and the README in English.

## Dates

- Nov 9, 2026: everything required works end to end.
- Nov 10: feature freeze, only bug fixes and design polish from here.
- Nov 11: video and written submission.
- Nov 12, 18:00 Riga time: submit (the hard deadline is 22:00).
