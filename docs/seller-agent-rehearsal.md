# Seller-agent runtime rehearsal

## Recorded evidence

The [runtime baseline](https://github.com/ever-guild/AgentShelf/commit/8b6e6d4834c6b94989db575064a1569f30ecedd6) passed 1,496 tests, lint, production build and the complete local HTTP/MCP scenario on a fresh database with PayPal, Anthropic and Render environment settings absent

Real Chrome verified owner registration, catalog access, mobile width, seller-header sign-out and legacy sign-in on the [identity candidate](https://github.com/ever-guild/AgentShelf/commit/e0e1004dad7be3465b94dce08486f5c953d17d5a), follow [PR #43](https://github.com/ever-guild/AgentShelf/pull/43) for subsequent review fixes

Record the exact revision for every later run in [release rehearsal #18](https://github.com/ever-guild/AgentShelf/issues/18), these results do not establish real Sandbox payments, an external assistant session or deployment of the candidate

## Local setup

Use Node.js 24 and PostgreSQL 17, create a new disposable database and leave `RENDER` unset, follow the [local README](../README.md#run-locally) and [architecture](architecture.md)

```bash
npm ci
createdb agentshelf_runtime
if [ ! -e .env.local ]; then cp .env.example .env.local; fi
```

Configure `DATABASE_URL`, `APP_SIGNING_SECRET` and `APP_ORIGIN=http://localhost:3000` in the ignored local file, the smoke uses deterministic CSV parsing and needs no Anthropic or PayPal credentials

Do not seed the owner-onboarding database, the scenario creates its own synthetic account and shops

```bash
npm run db:migrate
npm run build
npm run start
```

In a second terminal, explicitly acknowledge that this application uses a disposable database

```bash
RUNTIME_SMOKE_DISPOSABLE_DB=1 npm run smoke:runtime -- http://localhost:3000
```

The helper permits local HTTP origins only and creates persistent synthetic owners, shops, an import, catalog items, stock and search demand, discard the temporary database after the rehearsal

It verifies registration and sign-in, owner-only and shop-scoped grants, onboarding discovery, agent-created shop, cross-shop denial, grant revocation, CSV import/review/publication, stock adjustment from two to one and buyer search

It also requests checkout for the unconnected shop and requires `PAYMENT_NOT_CONFIGURED` without an approval URL or order capability, no provider order or payment is created

For a separate seeded-demo rehearsal, run `npm run db:seed`, then the existing `smoke:demo` and `smoke:mcp` commands, supply the current rehearsal date rather than copying an old date

## Browser checks

- Register a synthetic owner and shop through `/seller/register`, select the shop, open existing catalog and price-list screens
- At 390px and desktop width, confirm forms and catalog remain usable and the session cookie is HttpOnly
- Click Sign out in the existing seller header, revisit a protected page and require sign-in
- Sign in through the seeded-shop access-code form, require the owner API and owner pages to remain inaccessible
- Create a second owned shop, acknowledge `connect_paypal` sharing for shop A, switch to shop B and require a new acknowledgement before issuing a grant
- After successful grant issuance, require a fresh acknowledgement for another PayPal grant, never print or retain the raw grant in evidence

Use synthetic data only, API-based fixture creation must be identified separately from a UI action

## Acceptance matrix

| Area | Evidence required | Recorded state |
| --- | --- | --- |
| Owner onboarding | Fresh registration, shop persistence, catalog access | Local HTTP and Chrome PASS at the revisions above |
| Seller MCP | Independent buyer/seller principals, discovery, import/review/publication | Local SDK-to-HTTP PASS at the runtime baseline |
| Authorization | Wrong tenant, expiry, revoked grant and session | Database tests and local runtime PASS at the runtime baseline |
| Stock | Explicit policy, atomic allocation, contention and versioned adjustment | PostgreSQL suites and local 2-to-1 adjustment PASS at the runtime baseline |
| Unconnected checkout | No approval URL or order capability | Local negative-checkout PASS at the runtime baseline |
| Capture and booking | Timely capture, ambiguity, expiry, paid booking replay and late review | Provider-fixture and PostgreSQL suites PASS at the runtime baseline |
| Per-shop consent UI | Switching shops and successful grant issuance reset acknowledgement | Chrome PASS at [a7c2f62](https://github.com/ever-guild/AgentShelf/commit/a7c2f62ad07136c39f7871b3c4432ceb3e66fccf), including reset after successful issuance |
| Platform payment webhook | Signature-first verification, identifier agreement, deduplication and revoked-completed order | Run the platform webhook suite on the final revision, real delivery remains unverified |
| Sandbox seller/payment flow | Two consents, approval, recipient, capture and both webhook subscriptions | BLOCKED on app configuration and human Sandbox actions |
| External seller assistant | Real configured-client session performing seller tools | NOT RUN |
| Public deployment | Exact Render live SHA plus health and functional checks | Pending main integration, a draft PR does not deploy |

For an actual Sandbox rehearsal, follow [Sandbox setup](paypal-sandbox-setup.md), [merchant connection](paypal-merchant-connection.md) and [inventory behavior](inventory-contract.md), use separate subscription IDs for consent revocation and platform payment events

## Evidence record

Record revision, database type, command or manual action, result and remaining blocker, keep test fixtures, browser actions, real PayPal operations and deployment checks separate

Never include passwords, cookies, raw grants, approval URLs, payer data, raw webhook bodies or secret values, do not run order or booking smoke against a shared demo without its explicitly authorized rehearsal scope

Feature ownership remains in [registration #34](https://github.com/ever-guild/AgentShelf/issues/34), [merchant connection #35](https://github.com/ever-guild/AgentShelf/issues/35), [inventory #36](https://github.com/ever-guild/AgentShelf/issues/36) and [seller MCP #37](https://github.com/ever-guild/AgentShelf/issues/37), release evidence belongs in [#18](https://github.com/ever-guild/AgentShelf/issues/18) and the reproducible guide in [#19](https://github.com/ever-guild/AgentShelf/issues/19)
