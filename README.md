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

## Deploy

[`render.yaml`](render.yaml) defines the Render web service and database, and Render deploys `main` automatically. See [docs/deployment.md](docs/deployment.md).

## License

[MIT](LICENSE)
