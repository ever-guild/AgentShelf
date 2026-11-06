# AgentShelf

AgentShelf gives small shops a catalog and a buyer-facing MCP connector. A seller registers, creates a shop, imports a price list and reviews the catalog. A buyer's assistant can search shops and start checkout; a person approves payment in PayPal

**Live demo:** [agentshelf-e5bk.onrender.com](https://agentshelf-e5bk.onrender.com) · [MCP setup](docs/mcp.md) · [deployment status](docs/deployment.md)

## Try the shop

- Register or sign in at `/seller/register` and `/seller/owner-sign-in`, then create a shop in the seller area
- Import CSV or a price-list photo at `/seller/imports`; CSV extraction is available, photo extraction needs the operator's Anthropic key and has not been verified with a real model
- Review the rows before publishing, then manage the shop catalog and seller-agent access in the seller area
- The buyer MCP endpoint is `/mcp`; its tools include product search, booking, checkout and order status. See [MCP setup and current client status](docs/mcp.md)
- Seller MCP uses separate owner-authorized endpoints; see the [seller MCP contract](docs/seller-agent-mcp.md). No external seller-agent session has been verified

The operator configures one AgentShelf PayPal platform app. Each shop owner gives PayPal consent from `/seller/paypal-connection`; a connection screen is not proof that Sandbox consent, checkout or capture has succeeded. See the [platform setup](docs/paypal-platform-setup.md) and [Sandbox proof status](docs/paypal-sandbox-proof.md)

## Run the demo

Requires Node.js 24 and PostgreSQL 17

```bash
npm ci
createdb agentshelf_dev
if [ ! -e .env.local ]; then cp .env.example .env.local; fi
# Set DATABASE_URL and APP_SIGNING_SECRET in .env.local
npm run db:migrate
npm run db:seed
npm run dev
```

Open <http://localhost:3000>. Keep secrets in local environment files or the deployment secret store, never in Git

## Operate the hosted demo

Pushes to `main` run CI and, after it passes, request a Render deploy for that exact commit. The deploy workflow checks the live commit and readiness endpoints. Operators can follow [deployment and seeding instructions](docs/deployment.md); users can use the live demo link above

**Limits:** PayPal uses Sandbox only; real OAuth, seller consent, order approval, capture and webhook delivery are not yet proven end to end. External Claude and ChatGPT sessions have not been verified. See [the current runbook](docs/full-run.md) before a rehearsal

[Development and test commands](DEVELOP.md) · [Contribution guide](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
