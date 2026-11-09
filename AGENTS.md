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
- Sandbox only, no live credentials or live seller onboarding, the approved seller-connection work in [#35](https://github.com/ever-guild/AgentShelf/issues/35) may implement and test sandbox Partner Referrals with explicit merchant consent, actual platform permissions still require [proof #2](https://github.com/ever-guild/AgentShelf/issues/2)
- The repo is public. Secrets live only in environment variables: Render in production, `.env.local` locally. Add every new variable to `.env.example` with no value.
- Real customers' names, faces and data never appear in demo data or screenshots.

## Stack

- Next.js 16 and TypeScript (App Router, `src/`), Tailwind CSS
- Postgres on Render, through Drizzle ORM (see [docs/architecture.md](docs/architecture.md))
- MCP TypeScript SDK over Streamable HTTP (`/mcp` and `/mcp/seller/`)
- `@paypal/paypal-server-sdk` for Orders v2 (with APIMatic Context Plugin skills), PayPal JS SDK v6
- Configurable AI provider (OpenAI-compatible or Anthropic) for catalog photo import, descriptions, search terms and demand insights
- SQL full-text search with `unaccent` for product listings and demand tracking
- AG Grid / AG Studio for seller dashboard metrics and unmet demand
- Bryntum Scheduler (8.0 Community, MIT) for technician appointment management
- Render: Web Service and PostgreSQL database. A background Workflows task is implemented in the codebase, but a hosted workflow service has not been enabled or verified.

## How the flows use PayPal and AI

| Flow | PayPal | AI / Data Processing |
| --- | --- | --- |
| Seller onboarding | Platform Partner Referrals & merchant consent | Vision model extracts products from photo; CSV import parses deterministically |
| Catalog & inventory | PayPal Platform app payee routing | Explicit tracked/untracked stock policy; versioned conflict detection |
| Agent search & order | Orders v2 with seller as `payee` & approval link | SQL full-text matching with AI-suggested search terms; demand logging |
| After payment | Webhooks signature verification & capture | Automatic order reconciliation, hold commitment, and inventory decrement |
| Seller assistant | Dashboard demand summary and unmet search review | Provider-configured demand insights behind rate-limited server endpoints |
| Storefront for humans | JS SDK v6, PayPal buttons | Multi-lingual descriptions (English and Latvian) |

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

The scope delivered across milestones 1 and 2 includes self-service owner/shop registration ([#34](https://github.com/ever-guild/AgentShelf/issues/34)), sandbox merchant connection ([#35](https://github.com/ever-guild/AgentShelf/issues/35)), quantity inventory with conflict protection ([#36](https://github.com/ever-guild/AgentShelf/issues/36)), and an authorized external seller agent via MCP ([#37](https://github.com/ever-guild/AgentShelf/issues/37)). Final release rehearsals and evidence consolidation are tracked in [#18](https://github.com/ever-guild/AgentShelf/issues/18). See [docs/capabilities.md](docs/capabilities.md) for the active capability and proof matrix.

**Optional, in this order.** Start only once everything required works.

1. Seller copilot on Agent Toolkit ("refund order 12", "invoice Janis for the repair").
2. Channel3: product photos and specs, market price comparison.
3. "Try it" page with a chat agent, so judges can test without configuring an external assistant connector.
4. Seller notifications through Zapier, tracking numbers through Shipment Tracking.
5. WebMCP on the storefront, behind a browser support check.
6. Catalog import from a website through KERNEL.

**Out of scope:** real money, our own buyer agent as the main path, a mobile app, complex auth, full ACP and UCP support.

## Partner tools

Use these for real, because partner judges will notice superficial use.

- **AG Grid:** AG Studio with a custom theme, custom widgets and an agent in Studio Agent Framework. Plain tables are not enough.
- **Bryntum:** the buyer's agent books a slot and pays a deposit, and the booking appears in the scheduler. This is the center of the workshop demo.
- **APIMatic:** use the PayPal Context Plugin in the editor while writing PayPal code, and note this in the README.
- **Render:** Web Service and PostgreSQL host the app. Workflow task code exists, but hosted Workflows are not enabled or verified.

## Working in this repo

- Use native **Issue Type**: `Feature` for implementation, `Bug` for defects, `Task` for research or coordination
- Use **Fields** `field.priority` and `field.effort` for priority and effort, never duplicate these or Issue Type with labels
- Use **Relationships** `Blocked by` / `Blocking` for dependencies, keep issue descriptions in sync and avoid cycles, do not use `status:blocked`
- Update [README.md](README.md), [DEVELOP.md](DEVELOP.md), affected `docs/` pages and [CHANGELOG.md](CHANGELOG.md) in the same logical change when behavior, configuration, commands or paths change
- Before committing, verify local link targets and anchors, new or changed external links and documented commands, never invent releases, completed checks or external integration results

```bash
npm run dev    # local server on http://localhost:3000
npm run lint
npm run build
npm test       # needs TEST_DATABASE_URL; npm run test:unit needs no database
npm run db:migrate
npm run db:seed
npm run smoke:mcp -- URL   # checks a running /mcp endpoint
npm run smoke:checkout -- URL [--wait]   # creates one sandbox order through a running /mcp endpoint
npm run smoke:booking -- URL [--wait]   # holds one slot and creates its sandbox deposit order through a running /mcp endpoint
npm run smoke:import -- URL [FILE]   # uploads a price list to a running service and checks what was read
```

Run `npm run lint`, `npm run build` and `npm test` before pushing. [docs/architecture.md](docs/architecture.md) covers database setup, the rules the data model enforces and the shared service contracts.

- Deliver reviewed commits directly to `main`, keeping each commit to one issue and one reviewable result, follow [the collaboration workflow](docs/collaboration.md), parallel workers may commit completed slices in isolated worktrees and one integrator per agent run serializes their publication, refresh main before integration and push, never leave completed work uncommitted solely because the whole feature is unfinished
- [CI](.github/workflows/ci.yml) runs lint, the full test suite with an isolated Postgres and the production build; its post-validation deploy job uses GitHub Environment `agentshelf-e5bk.onrender.com` as source of truth for the three `AGENT_SHELF_AI_PROVIDER*` settings and the `AG_STUDIO` secret/runtime setting, then requests the exact commit SHA through repository secret `RENDER_DEPLOY_HOOK_URL` and verifies a new live deploy plus public health and readiness. The Environment also needs `RENDER_API_KEY`; a manual workflow dispatch from `main` re-syncs and redeploys that same SHA. CI and deploy concurrency do not cancel a running publish sequence. Render's native auto-deploy is disabled in [render.yaml](render.yaml); to freeze publishing, disable the GitHub Actions deploy job or its publishing gate as well.
- Each area has one owner: PayPal and backend; MCP and AI search; onboarding and booking; dashboard and submission. Stay inside the area you were asked to work on, and flag changes that reach into another.
- Scope decisions belong to the team captain, so ask rather than adding features.
- Write UI text, code, comments and the README in English.
- UI work follows the [unslop skill](.agents/skills/unslop/SKILL.md) and [docs/design-direction.md](docs/design-direction.md). Audit a screen against the skill's `references/signs.md` before calling it done.

## Dates

- Nov 9, 2026: everything required works end to end.
- Nov 10: feature freeze, only bug fixes and design polish from here.
- Nov 11: video and written submission.
- Nov 12, 18:00 Riga time: submit (the hard deadline is 22:00).
