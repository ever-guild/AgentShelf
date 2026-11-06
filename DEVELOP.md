# Develop AgentShelf

## Setup and checks

Use Node.js 24 and PostgreSQL 17, create a local database and `.env.local` from `.env.example`, then run migrations and seed data as described in the [README](README.md)

```bash
npm run dev
npm run lint
npm test                 # requires TEST_DATABASE_URL pointing to a disposable PostgreSQL instance
npm run test:unit        # database-free unit tests
npm run build
```

Before publication run lint, the complete test suite against disposable PostgreSQL 17, and the production build; CI runs the same checks, see [deployment](docs/deployment.md)

## Code map

- `src/app` contains seller, storefront, health, checkout and MCP routes
- `src/server` contains shared services, database access, contracts and provider adapters
- `src/server/db/schema.ts` contains the Drizzle schema; `drizzle` contains generated migration files
- `scripts` contains migration, seed and smoke commands

Read [architecture and service contracts](docs/architecture.md) before changing shared behavior; the buyer connector at `/mcp` and seller endpoints are separate, review [MCP contracts](docs/mcp.md) and [seller agent contract](docs/seller-agent-mcp.md)

## Integration evidence

The installed PayPal Server SDK is `@paypal/paypal-server-sdk` 2.5.0; APIMatic PayPal Context Plugin skills were used while writing its client/controller configuration, request models, error handling and mocked transport tests; these are coding references, not a runtime integration or evidence of a real payment, see [the integration record](docs/integrations.md#apimatic-context-plugin) and [Sandbox proof runbook](docs/paypal-sandbox-proof.md)

AG Studio and Bryntum are installed partner packages; their usage and verification limits are recorded in [integrations.md](docs/integrations.md); AG Studio has its own commercial license, PayPal Agent Toolkit is not installed as a runtime dependency; shared agent guidance lives in [AGENTS.md](AGENTS.md) and reusable project skills in [`.agents/skills`](.agents/skills/unslop/SKILL.md)

## Useful operational commands

```bash
npm run db:migrate
npm run db:seed
npm run smoke:demo -- http://localhost:3000/mcp
npm run smoke:mcp -- http://localhost:3000/mcp
```

See [deployment](docs/deployment.md), [full run](docs/full-run.md), and [Postman smoke collection](docs/postman/README.md) for hosted operation; checkout and booking smoke commands can create Sandbox orders, follow the PayPal runbook and use a disposable environment before running them
