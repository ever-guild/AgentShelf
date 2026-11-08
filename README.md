# AgentShelf

Register a shop, import a price list and review the catalog, then let buyers search and start checkout through their assistants
A person approves payment in PayPal

**Live demo:** [agentshelf-e5bk.onrender.com](https://agentshelf-e5bk.onrender.com) · [MCP setup](docs/mcp.md) · [deployment status](docs/deployment.md)

[Privacy policy](https://agentshelf-e5bk.onrender.com/privacy) · [User agreement](https://agentshelf-e5bk.onrender.com/terms)

## Try the shop

- Select **Log in with PayPal** for Sandbox login, confirm your shop, then connect its PayPal merchant account, the operator must first complete [Login setup](docs/paypal-login.md)
- Existing password owners can [sign in](https://agentshelf-e5bk.onrender.com/seller/owner-sign-in) or [register](https://agentshelf-e5bk.onrender.com/seller/register)
- Import CSV or a price-list photo at `/seller/imports`; CSV extraction is available, photo extraction needs the operator's Anthropic key and has not been verified with a real model
- Review the rows before publishing, then manage the shop catalog and seller-agent access in the seller area
- After publishing, open the catalog and choose a tracked quantity or an explicit untracked policy for each physical product before buyers can check out
- The buyer MCP endpoint is `/mcp`; its tools include product search, booking, checkout and order status, see [MCP setup and current client status](docs/mcp.md)
- Seller MCP uses separate owner-authorized endpoints; see the [seller MCP contract](docs/seller-agent-mcp.md), no external seller-agent session has been verified

The operator configures one AgentShelf PayPal platform app, each shop owner gives PayPal consent from `/seller/paypal-connection`; a connection screen is not proof that Sandbox consent, checkout or capture has succeeded, see the [platform setup](docs/paypal-platform-setup.md) and [Sandbox proof status](docs/paypal-sandbox-proof.md)

## Run the demo

Requires Node.js 24 and PostgreSQL 17

```bash
npm ci
createdb agentshelf_dev
if [ ! -e .env.local ]; then cp .env.example .env.local; fi
# Set DATABASE_URL, APP_SIGNING_SECRET and APP_ORIGIN=http://localhost:3000 in .env.local
npm run db:migrate
npm run db:seed
npm run dev
```

Open <http://localhost:3000>; keep secrets in local environment files or the deployment secret store, never in Git

## Operate the hosted demo

Pushes to `main` run CI and, after it passes, request a Render deploy for that exact commit; the deploy workflow checks the live commit and readiness endpoints, operators can follow [deployment and seeding instructions](docs/deployment.md), and users can use the live demo link above

**Limits:** PayPal uses Sandbox only; real OAuth, seller consent, order approval, capture and webhook delivery are not yet proven end to end; external Claude and ChatGPT sessions have not been verified, see [the current runbook](docs/full-run.md) before a rehearsal

[Development and test commands](DEVELOP.md) · [Contribution guide](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
