# AgentShelf

Make any small shop buyable by AI agents in 5 minutes. A seller photographs their price list, AI builds a catalog, and the shop appears in one MCP connector. The buyer's assistant (Claude, ChatGPT) finds a product or a free slot and creates an order, and the buyer confirms payment in PayPal.

Early development. PayPal runs in sandbox only.

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

## Deploy

Live demo: [AgentShelf](https://agentshelf-e5bk.onrender.com)

[`render.yaml`](render.yaml) defines the Render web service and database, pushes to `main` run CI with lint, tests against an isolated PostgreSQL 17 service and a production build on Node.js 24

After CI passes, GitHub Actions calls the Render Deploy Hook for that exact commit and verifies its public health endpoints, see [deployment and verification details](docs/deployment.md) and [deployment issue #31](https://github.com/ever-guild/AgentShelf/issues/31)

## License

[MIT](LICENSE)
