# Develop AgentShelf

## Prerequisites

- Node.js 24, the npm bundled with it, and Git
- PostgreSQL 17, either installed locally or in Docker
- No PayPal, Anthropic, AG Studio or Render account is needed to run locally

Run the commands from a shell that does not export provider secrets. Variables set in the shell override `.env.local`, so a stray `PAYPAL_*` or `ANTHROPIC_API_KEY` would turn a local run into a provider run. Leave `RENDER` unset. On Render it makes startup create and seed the demo database.

## Run locally

1. Install dependencies

```bash
npm ci
```

npm 12 reports blocked `esbuild` install scripts. Migrations, `tsx` scripts and the production build still work without approving them.

2. Create an empty database

```bash
createdb agentshelf_dev
# or, without a local PostgreSQL:
docker run -d --name agentshelf-dev-db -e POSTGRES_PASSWORD=<choose-one> -p 127.0.0.1:5432:5432 postgres:17
docker exec agentshelf-dev-db createdb -U postgres agentshelf_dev
```

3. Configure `.env.local`

```bash
if [ ! -e .env.local ]; then cp .env.example .env.local; fi
```

Set only these three values and leave the provider settings blank:

| Variable | Local value |
| --- | --- |
| `DATABASE_URL` | Your local database, for example `postgres://postgres:<password>@127.0.0.1:5432/agentshelf_dev` |
| `APP_SIGNING_SECRET` | A random value of at least 32 characters, for example from `openssl rand -base64 32` |
| `APP_ORIGIN` | `http://localhost:3000`, or the port you start on |

4. Migrate, choose one data mode, then build and start

```bash
npm run db:migrate
npm run db:seed        # fixture mode only, see below
npm run build
npm run start          # or `npm run dev` while editing
```

5. Check it

```bash
curl -fsS http://localhost:3000/api/health/ready
npm run smoke:mcp -- http://localhost:3000/mcp    # fixture mode
npm run smoke:demo -- http://localhost:3000/mcp   # fixture mode
```

Expect `{"status":"ready"}` and only `PASS` lines. On a local build, `/api/health` reports `"commit": null`.

### Data modes

| Mode | How to get it | What you have | What it does not show |
| --- | --- | --- | --- |
| Fixtures | `npm run db:seed` on your own empty database | Two synthetic demo shops, 8 listings, 2 technicians and 8 demand samples. No owner accounts. The legacy access-code sign-in at `/seller/sign-in` works only after setting `DEMO_*_SELLER_CODE` before seeding | Payments. Without legacy PayPal settings, `create_checkout` and `book_slot` answer `PAYMENT_NOT_CONFIGURED` and create no order. Search reports `matching.mode: "degraded"` without an Anthropic key |
| Owner | Skip the seed and register at `/seller/register` | The current product path: owner account, shops, imports, explicit stock policy, seller-agent grants | PayPal consent and payment, which need the [platform setup](docs/paypal-platform-setup.md) and human Sandbox actions |

`npm run db:seed` and `npm run demo:reset` change demo rows. Run them only against your own disposable database. `demo:reset` also requires `DEMO_ENVIRONMENT=true` and refuses any database that holds an owner-created shop. Never run them against a shared or hosted database to "start clean". The [full run](docs/full-run.md) explains how a rehearsal reuses existing shops instead.

For the owner path, a disposable database without the seed can be checked end to end with no provider credentials:

```bash
RUNTIME_SMOKE_DISPOSABLE_DB=1 npm run smoke:runtime -- http://localhost:3000
```

It creates synthetic owners, shops, grants, an import and stock, and expects `PAYMENT_NOT_CONFIGURED` for the unconnected shop. See the [seller-agent rehearsal](docs/seller-agent-rehearsal.md#local-setup).

### What the smoke scripts can check

| Command | Assumes | Use it for |
| --- | --- | --- |
| `smoke:mcp`, `smoke:demo` | The seeded demo product, shop and service UUIDs | Fixture databases and the hosted demo shops |
| `smoke:runtime` | A local HTTP origin and a disposable database it may write to | The owner and seller-agent path without providers |
| `smoke:checkout`, `smoke:booking` | The seeded demo shop and the legacy `PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP` app, and they create Sandbox orders | Diagnostics of the legacy direct-merchant path only |
| `smoke:import` | The legacy demo shop and `DEMO_PHONE_WORKSHOP_SELLER_CODE`, plus a model key for photos | The legacy seller sign-in path only |
| `paypal:proof`, `paypal:preflight` | The legacy per-shop PayPal app variables | Legacy credential diagnostics |
| `paypal:platform-preflight` | The `PAYPAL_PLATFORM_*` settings | Checking the platform app configuration before seller consent, see [platform setup](docs/paypal-platform-setup.md) |

None of the payment smoke scripts works for a shop an owner registered and connected through the PayPal platform. For those shops, call the buyer tools directly as [MCP setup](docs/mcp.md#check-a-connected-shop) describes.

## Tests and checks

```bash
npm run lint
npm run test:unit      # no database
npm test               # needs TEST_DATABASE_URL pointing to a disposable PostgreSQL server
npm run build
```

The full suite creates and drops temporary databases on the server in `TEST_DATABASE_URL`, so never point it at a database you want to keep. Before publication run lint, the complete suite against disposable PostgreSQL 17 and the production build. CI runs the same checks, see [deployment](docs/deployment.md).

## Code map

- `src/app` contains seller, storefront, health, checkout and MCP routes
- `src/server` contains shared services, database access, contracts and provider adapters
- `src/server/db/schema.ts` contains the Drizzle schema; `drizzle` contains generated migration files
- `scripts` contains migration, seed and smoke commands

Read [architecture and service contracts](docs/architecture.md) before changing shared behavior. The buyer connector at `/mcp` and the seller endpoints are separate: review [MCP contracts](docs/mcp.md) and the [seller agent contract](docs/seller-agent-mcp.md).

PayPal identity login has separate credentials and callbacks from merchant consent, see [Login setup and verification limits](docs/paypal-login.md). Never use profile email or a browser callback hint as proof of shop ownership or payment permission.

## Integration evidence

The installed PayPal Server SDK is `@paypal/paypal-server-sdk` 2.5.0. APIMatic PayPal Context Plugin skills were used while writing its client and controller configuration, request models, error handling and mocked transport tests. These are coding references, not a runtime integration or evidence of a real payment, see [the integration record](docs/integrations.md#apimatic-context-plugin) and the [Sandbox proof runbook](docs/paypal-sandbox-proof.md).

AG Studio and Bryntum are installed partner packages; their usage and verification limits are recorded in [integrations.md](docs/integrations.md). AG Studio has its own commercial license. PayPal Agent Toolkit is not installed as a runtime dependency. Shared agent guidance lives in [AGENTS.md](AGENTS.md) and reusable project skills in [`.agents/skills`](.agents/skills/unslop/SKILL.md).

For hosted operation see [deployment](docs/deployment.md), the [full run](docs/full-run.md) and the [Postman smoke collection](docs/postman/README.md).
