# Seller-agent runtime rehearsal

## Snapshot

This matrix describes the combined review candidate at [`b31ca1b`](https://github.com/ever-guild/AgentShelf/commit/b31ca1b535b43f4eccdd29582a7bf0dabbb070f8), inspected on 6 November 2026. It is a review worktree, not `main` and not the deployed demo.

The [identity PR #43](https://github.com/ever-guild/AgentShelf/pull/43) has green CI. The seller MCP SDK check for [#41](https://github.com/ever-guild/AgentShelf/commit/35471cd42364a34bb55588208068fc75370d0144) passed against that exact commit. Final negative-checkout and header/logout compatibility QA for the combined candidate is pending. A real Claude Code session and real PayPal Sandbox onboarding, webhook, approval and capture remain unverified.

Use the statuses carefully:

| Status | Meaning |
| --- | --- |
| `IMPLEMENTED` | Code and runtime route exist in the review candidate; no run is implied |
| `PASS` | The named check ran against the stated SHA and expected evidence was recorded |
| `FAIL` | The check ran and contradicted its expected result |
| `BLOCKED` | A required capability, credential or human action is unavailable |
| `NOT RUN` | The capability exists, but the check did not run against this candidate |

Record implementation, automated tests, local runtime execution, browser/client checks, PayPal Sandbox evidence and public deployment separately. Green CI from one PR is not a pass for the combined candidate. A healthy URL does not show that it serves this SHA.

## Local rehearsal

Use Node.js 24 and PostgreSQL 17. Create a new disposable database and leave `RENDER` unset. Keep `.env.local` private; do not print its values. Follow the [local README](../README.md#run-locally) and [architecture setup](architecture.md#local-setup):

```bash
npm install
createdb agentshelf_runtime
if [ ! -e .env.local ]; then cp .env.example .env.local; fi
```

Set `DATABASE_URL`, `APP_SIGNING_SECRET`, and `APP_ORIGIN=http://localhost:3000` in `.env.local`. The runtime smoke's CSV import also needs `ANTHROPIC_API_KEY`. Do not run `db:seed` for the owner-onboarding smoke; it creates its own synthetic owner and shops. Apply migrations and start the app:

```bash
npm run db:migrate
npm run dev
```

In a second terminal, explicitly acknowledge that the app is using the disposable database before running the smoke:

```bash
RUNTIME_SMOKE_DISPOSABLE_DB=1 npm run smoke:runtime -- http://localhost:3000
```

The command is restricted to local HTTP origins. It creates persistent synthetic owners, shops, an import/catalog row, stock records and demand from a buyer search. It checks unauthenticated owner access, registration, sign-in, owner shop creation, one-use onboarding grant scope, shop-bound grants, cross-shop denial, revocation, seller import/review/publication, stock setup/adjustment, buyer search, and the owner sign-out API. It then expects an unconfigured shop's checkout to return `PAYMENT_NOT_CONFIGURED` without an approval URL or order capability. It does not clean up its rows; keep the database disposable.

This is a local SDK-to-HTTP rehearsal, not a browser run or a Claude Code connection. It does not call PayPal or prove human approval, capture, webhook delivery or real Sandbox readiness. The import step uses the configured AI provider; it is not the same as testing a real external assistant as an MCP client.

To rehearse the seeded demo separately, run `npm run db:seed`, then use `npm run smoke:demo -- http://localhost:3000/mcp --date YYYY-MM-DD` and `npm run smoke:mcp -- http://localhost:3000/mcp`. Those searches add demand events. The old `/seller/sign-in` access-code path is for seeded demo shops; owner signup and management use `/seller/register`, `/seller/owner-sign-in`, `/seller/shops`, `/seller/agent-access` and `/seller/paypal-connection`.

## Runtime routes and safety gates

Owner identity routes are under `/api/seller/identity/*`; owner sessions and membership govern shops. Seller MCP is separate from the public buyer connector:

- `POST /mcp/seller/onboarding` accepts an owner-level bearer grant and exposes only `seller_create_shop`.
- `POST /mcp/seller/shop/{shopId}` requires a live grant for that shop and exposes only configured tools allowed by the grant's scopes.
- The current seller tools are `seller_create_shop`, `seller_import_price_list`, `seller_review_import`, `seller_manage_catalog`, `seller_manage_stock` and `seller_connect_paypal`.
- `create_shop` is one-use. The owner must issue a second, shop-bound grant for management. Grants are returned once, expire after 15 minutes and can be revoked; the raw token is not recoverable.
- PayPal scope requires an explicit owner data-sharing acknowledgement when the grant is issued. The owner PayPal page has its own unchecked-by-default acknowledgement before it starts a Sandbox referral. The agent cannot supply consent in tool arguments.

The candidate includes migrations `0011` through `0015` for identity/grants, merchant connections, inventory reservations, order PayPal credential snapshots and legacy/demo inventory initialization. See the [seller-agent integration handoff](seller-agent-integration-handoff.md), [seller identity contract](seller-identity.md), [seller MCP contract](seller-agent-mcp.md), [inventory contract](inventory-contract.md) and [PayPal connection contract](paypal-merchant-connection.md) for the exact service and route rules.

Physical stock is `tracked`, `untracked`, or undecided (no row). Tracked `available` is `on_hand - reserved`; untracked is not zero. Checkout reserves the cart atomically before issuing an approval link. Reconciliation claims one new capture attempt for a live reservation. It commits stock only after a verified completed capture with a provider timestamp before expiry. A late completed capture moves the order/reservation to `review_required` and does not consume stock; an uncertain result keeps stock reserved. A verified unpaid/expired/cancelled result can release the reservation. The repair appointment hold remains a separate resource with its own no-capture-after-expiry gate.

The PayPal Sandbox Platform REST app uses `PAYPAL_PLATFORM_CLIENT_ID`, `PAYPAL_PLATFORM_CLIENT_SECRET`, `PAYPAL_PLATFORM_MERCHANT_ID` and `PAYPAL_PARTNER_ATTRIBUTION_ID`. `PAYPAL_PLATFORM_WEBHOOK_ID` verifies platform consent-revocation events; legacy per-seller order webhooks use `PAYPAL_WEBHOOK_ID_<REF>`. Values belong only in `.env.local` or a deployment secret store. The candidate exposes configuration readiness without secret values; missing platform setup blocks a referral. No real credentials or secret values belong in this record.

## Acceptance matrix

| ID | Stage | Scenario | Check and evidence | Candidate state |
| --- | --- | --- | --- | --- |
| BASE-1 | 3 | Seeded two-shop buyer path | Run `smoke:demo`; retain sanitized output and SHA | `NOT RUN` for `b31ca1b`; helper exists |
| BASE-2 | 3 | Buyer MCP initialization and invalid input | Run `smoke:mcp`; confirm buyer tools and rejection of malformed checkout | `NOT RUN` for `b31ca1b`; helper exists |
| BASE-3 | 3 | Seeded seller CSV review | Sign in at `/seller/sign-in`, upload synthetic CSV, review and confirm local publication | `NOT RUN` for `b31ca1b` |
| UI-1 | 3 | Owner registration, selection and consent screens | Exercise registration/sign-in, shop selection, agent access and PayPal page in a browser at desktop/mobile widths | `IMPLEMENTED`; visual/browser rehearsal and final header/logout QA pending |
| OWNER-1 | 3 | Owner starts without seeded shop data | Run `smoke:runtime`; confirm account and shop access persist through sign-in | `IMPLEMENTED`; exact candidate smoke `NOT RUN` |
| MCP-1 | 1, 3 | Seller MCP tool discovery and SDK transport | Record SDK client/server checks against the exact tested commit; separately record any remote client session | #41 SDK check `PASS` at [`35471cd`](https://github.com/ever-guild/AgentShelf/commit/35471cd42364a34bb55588208068fc75370d0144); no Claude Code session verified |
| AGENT-1 | 3 | Authorized seller agent imports, reviews and publishes | Run `smoke:runtime`; buyer MCP finds the published product with a separate public principal | `IMPLEMENTED`; final candidate runtime smoke `NOT RUN` |
| AUTH-1 | 2, 3 | Foreign-shop grant and revoked grant are denied | Run identity DB/route tests and `smoke:runtime`; save sanitized status/code only | Identity PR #43 CI `PASS`; combined candidate smoke `NOT RUN` |
| STOCK-1 | 2, 3 | Tracked quantity and purchase reservation | Set three units, reserve two, verify one available and immutable order quantity | `IMPLEMENTED`; focused candidate integration run pending |
| STOCK-2 | 2 | Buyers contend for last unit | Concurrent reservations yield one winner and no oversell | `IMPLEMENTED`; focused candidate integration run pending |
| STOCK-3 | 2 | Expired reservation blocks new capture | Expire before capture and confirm no new provider capture is sent | `IMPLEMENTED`; focused candidate integration run pending |
| STOCK-4 | 2 | Provider reports a late verified capture | Require `review_required`, no stock consumption and no fulfillment | `IMPLEMENTED`; focused candidate integration run pending |
| PAYPAL-1 | 1, 2, 3 | Unconnected shop cannot create a checkout order | Expect `PAYMENT_NOT_CONFIGURED`, with no approval URL or order capability | `IMPLEMENTED`; new combined-candidate negative-checkout QA pending |
| PAYPAL-2 | 4 | Owner-consented Sandbox merchant connection and revocation | Complete Partner Referrals as a human, refresh verified status, deliver a verified revocation event and confirm checkout is blocked | Consent/runtime routes `IMPLEMENTED`; real Sandbox flow `NOT RUN` |
| PAY-1 | 2 | Duplicate order webhook delivery | Deliver a verified fixture twice and require one transition | Handler/test coverage exists; candidate release result `NOT RUN` |
| PAY-2 | 2 | Expired/cancelled repair hold | Confirm no new capture starts after hold expiry/cancellation | Implemented with database coverage in [commit `db9293c`](https://github.com/ever-guild/AgentShelf/commit/db9293c77dc7dd48026276f6cb5efd43a3e240ad); final candidate run `NOT RUN` |
| PAY-3 | 2 | Capture already completed after repair hold expiry | Preserve capture evidence, mark review, and do not confirm or double-book | Database coverage exists in [commit `db9293c`](https://github.com/ever-guild/AgentShelf/commit/db9293c77dc7dd48026276f6cb5efd43a3e240ad); final candidate run `NOT RUN` |
| DEPLOY-1 | 5 | Exact candidate is live | Verify Render `live` SHA and public health/readiness responses after integration to `main` | `NOT RUN`; `b31ca1b` is not `main` or a deployment |

`smoke:runtime` exercises the negative checkout only. It does not prove a real PayPal order, buyer approval, capture or webhook. The automated PayPal fixtures are stand-ins, not a Sandbox transaction.

## Evidence record

Record the exact candidate SHA, database type, command or manual path, status, sanitized output and blocker. Never record passwords, cookies, agent grants, approval URLs, payer data, raw webhook bodies or PayPal credentials. Record the sandbox operation separately from mock/fixture tests and do not run order/booking smoke commands against a shared demo.

## Cross-issue handoff

The release rehearsal is tracked by [#18](https://github.com/ever-guild/AgentShelf/issues/18), and this public rehearsal guide by [#19](https://github.com/ever-guild/AgentShelf/issues/19). Relevant implementation issues are [owner identity #34](https://github.com/ever-guild/AgentShelf/issues/34), [PayPal onboarding #35](https://github.com/ever-guild/AgentShelf/issues/35), [inventory #36](https://github.com/ever-guild/AgentShelf/issues/36) and [seller MCP #37](https://github.com/ever-guild/AgentShelf/issues/37). The physical-stock capture rule and repair-booking hold rule stay separate; an already completed late capture remains under review.
