# AgentShelf

Make any small shop buyable by AI agents in 5 minutes. A seller photographs their price list, AI builds a catalog, and the shop appears in one MCP connector. The buyer's assistant (Claude, ChatGPT) finds a product or a free slot and creates an order, and the buyer confirms payment in PayPal.

Early development. PayPal runs in sandbox only.

As of 6 November 2026, the controlled Orders proof is blocked for both seller accounts because their separate Sandbox app credentials are not configured, see the [PayPal sandbox proof runbook](docs/paypal-sandbox-proof.md) for the approval and capture gates

The `create_checkout` tool creates sandbox orders through the [shared checkout service](docs/architecture.md#checkout), and [approval, capture and webhooks](docs/architecture.md#payment-reconciliation) settle them, but for the same reason no real PayPal order or payment has gone through this code yet

Sellers can sign in at `/seller/imports`, upload a CSV or a photo of a price list and correct the rows in a table, as [Catalog import](docs/architecture.md#catalog-import) explains. CSV works today. Reading a photo needs `ANTHROPIC_API_KEY`, and no real model has read one yet. Publishing the result is [not built yet](https://github.com/ever-guild/AgentShelf/issues/9).

## Run locally

You need Node.js 24 and PostgreSQL 17.

```bash
npm install
createdb agentshelf_dev
cp .env.example .env.local   # then fill in the values
npm run db:migrate
npm run db:seed
npm run dev
```

Open http://localhost:3000.

[docs/architecture.md](docs/architecture.md) explains the environment variables, the data model and the service contracts.

## Test

```bash
npm test            # needs TEST_DATABASE_URL, a Postgres server for temporary test databases
npm run test:unit   # needs no database
```

## Connect an assistant

The connector is an MCP server at `/mcp`. [docs/mcp.md](docs/mcp.md) explains how to add it to Claude and ChatGPT, and what it can do so far.

For PayPal development, follow the [project-scoped agent setup](docs/paypal-agent-setup.md) to install the official PayPal and APIMatic guidance, these skills provide development context and do not enable payments

The diagnostic Orders proof uses APIMatic PayPal Context Plugin skills while writing client and controller setup, request models, and mocked transport checks for `@paypal/paypal-server-sdk` 2.5.0; the [runbook](docs/paypal-sandbox-proof.md) records this work without claiming a real Sandbox payment

The [checkout and reconciliation services](src/server/paypal/orders.ts) were written with the same skills, [integrations.md](docs/integrations.md#apimatic-context-plugin) records what they changed in that code

## Deploy

Live demo: [AgentShelf](https://agentshelf-e5bk.onrender.com)

[`render.yaml`](render.yaml) defines the Render web service and database, pushes to `main` run CI with lint, tests against an isolated PostgreSQL 17 service and a production build on Node.js 24

After CI passes, GitHub Actions calls the Render Deploy Hook for that exact commit and verifies its public health endpoints, see [deployment and verification details](docs/deployment.md) and [deployment issue #31](https://github.com/ever-guild/AgentShelf/issues/31)

## License

[MIT](LICENSE)
