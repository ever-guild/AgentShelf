# AgentShelf seller-agent setup: prepare a safe rehearsal

## Purpose

This guide prepares a local environment for the current demo and the future owner-led seller-agent rehearsal

The current seller login is for two seeded demo shops, it is not a public shop-registration flow or an external seller-agent authorization system

## Requirements

- Node.js 24
- PostgreSQL 17 on a disposable local database
- A current checkout of the candidate branch
- Optional access codes chosen by the operator for the synthetic demo shops

No PayPal account is required to rehearse catalog import, review, or the buyer search path, actual PayPal operations are outside this setup guide

## Local demo setup

Install dependencies and create `.env.local` only when it is absent, keep any existing file intact

```bash
npm ci
if [ ! -e .env.local ]; then cp .env.example .env.local; fi
```

Create an empty local database before migrating it

```bash
createdb agentshelf_dev
```

Set `DATABASE_URL`, `APP_SIGNING_SECRET`, and the two demo seller access-code variables in the ignored local environment file, optionally set `DEMO_DATE` to a stable Riga date, do not print environment values

```text
DEMO_PHONE_WORKSHOP_SELLER_CODE
DEMO_SECOND_SHOP_SELLER_CODE
```

Run migrations and seed the two fixed demo shops, then start the application

```bash
npm run db:migrate
npm run db:seed
npm run dev
```

Open `/seller/sign-in` and sign in separately as `demo-phone-workshop` and `demo-candle-studio`, each code is only a demo shop access boundary and does not represent an owner account

For the buyer path, use the documented public MCP connector at `/mcp`, the current helper checks both seeded shops without creating a checkout order

```bash
npm run smoke:demo -- http://localhost:3000/mcp --date 2026-11-06
```

The helper records search demand, use a disposable database and keep these synthetic searches separate from real seller analytics

For transport and schema checks, run the MCP helper, it sends malformed checkout input only

```bash
npm run smoke:mcp -- http://localhost:3000/mcp
```

See [architecture local setup](architecture.md#local-setup) for database requirements and [demo data](architecture.md#demo-data) for the seeded fixtures

## Prepare owner-led onboarding tests

Shop registration and owner identity are tracked in [issue #34](https://github.com/ever-guild/AgentShelf/issues/34), seller-agent MCP is tracked in [issue #37](https://github.com/ever-guild/AgentShelf/issues/37), shared-screen design is tracked in [issue #39](https://github.com/ever-guild/AgentShelf/issues/39), follow their merged UI and MCP contracts when available, do not infer endpoints or tool names from this guide

For a clean onboarding run, create a separate empty database and do not run `db:seed`, register one shop through the shipped owner UI or owner-authorized agent path, then obtain an explicit owner-issued management grant for that shop before using seller tools, verify both persist after restart, and keep a second independent shop for isolation checks

Record the shop IDs only in local test notes, use non-sensitive synthetic shop names and catalog data, and verify owner authorization before granting any external agent access

The exact access token, scopes, revocation mechanism, and manual owner-confirmation step must come from the shipped feature contract, never reuse the current shared demo access code as an agent credential, a `create_shop` grant does not authorize later shop management and the owner must issue a separate membership-bound grant for that shop

## Prepare inventory checks

Inventory quantity and reservation lifecycle are tracked in [issue #36](https://github.com/ever-guild/AgentShelf/issues/36), use its contract for available quantity, reserved quantity, payment-pending state, capture, cancellation, expiry, and restock behavior

Use a disposable database with a product set to three units, verify a quantity-two purchase leaves one available according to the documented policy, then race two buyers for a one-unit product and require only one reservation to succeed

An expired inventory reservation must block a new capture request, if verified capture already completed after expiry reconcile it as `review_required` and do not consume stock or create a second allocation, align inventory issue [#36](https://github.com/ever-guild/AgentShelf/issues/36) with the booking capture guard in [#38](https://github.com/ever-guild/AgentShelf/issues/38)

Do not substitute appointment slots for inventory, the scheduler's technician holds protect time ranges and are a separate resource

## PayPal boundary

Platform PayPal sandbox consent is tracked in [issue #35](https://github.com/ever-guild/AgentShelf/issues/35), issue [#2](https://github.com/ever-guild/AgentShelf/issues/2) owns credential and recipient proof, checkout creation is in [#6](https://github.com/ever-guild/AgentShelf/issues/6), capture and webhooks are in [#11](https://github.com/ever-guild/AgentShelf/issues/11), booking capture prevention after an expired or cancelled hold is tracked in [#38](https://github.com/ever-guild/AgentShelf/issues/38)

Before consent is completed, the expected behavior is that the shop and catalog remain usable while checkout clearly reports that payments are not configured, it must not return a fabricated approval link or create a provider order

This task does not run a sandbox order, approve or capture a payment, register a webhook, or require buyer credentials, the approved end-to-end payment rehearsal belongs in [#18](https://github.com/ever-guild/AgentShelf/issues/18) after the owner authorizes it

The existing [PayPal sandbox setup guide](paypal-sandbox-setup.md) describes the diagnostic seller-app configuration, treat it as separate from the target platform onboarding flow until issue [#35](https://github.com/ever-guild/AgentShelf/issues/35) replaces that setup

## Validation commands

Use the project test suite on a disposable PostgreSQL server, it creates and drops temporary test databases and must not point at the demo database

```bash
npm run test:unit
npm run lint
npm run build
```

When `TEST_DATABASE_URL` is available for a disposable PostgreSQL test server, run `npm test` as well, existing database tests cover duplicate webhook delivery, late booking capture, and the no-PayPal checkout boundary

Record command results against the commit under review, distinguish automated PayPal stand-in tests from real Sandbox outcomes, and use `BLOCKED` rather than a skipped pass for any unimplemented onboarding, seller-agent, inventory, or consent path

## Handoff to implementation owners

Catalog import and publication should continue through the shared catalog service in [#9](https://github.com/ever-guild/AgentShelf/issues/9), search changes should use its indexing path in [#10](https://github.com/ever-guild/AgentShelf/issues/10)

Inventory reservations must integrate with checkout and settlement through [#6](https://github.com/ever-guild/AgentShelf/issues/6) and [#11](https://github.com/ever-guild/AgentShelf/issues/11), product sales must not claim a technician booking hold from [#12](https://github.com/ever-guild/AgentShelf/issues/12)

Human storefront checkout in [#16](https://github.com/ever-guild/AgentShelf/issues/16) must share inventory rules with buyer MCP, keep the two synthetic shops and their independent seller scopes in [#17](https://github.com/ever-guild/AgentShelf/issues/17)

The release rehearsal and this public runbook are tracked by [#18](https://github.com/ever-guild/AgentShelf/issues/18) and [#19](https://github.com/ever-guild/AgentShelf/issues/19), the rehearsal also depends on booking capture guard [#38](https://github.com/ever-guild/AgentShelf/issues/38) and shared-screen design pass [#39](https://github.com/ever-guild/AgentShelf/issues/39)
