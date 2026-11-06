# AgentShelf seller-agent rehearsal: acceptance matrix

## Purpose

This document defines a repeatable rehearsal for the current seller and buyer paths and the owner-led seller-agent flow

The target scenario is owner-authorized shop setup, seller-side catalog and stock management, buyer-side discovery and purchase, with a person approving any PayPal payment

## Snapshot and status

The current-code baseline is [commit 9c84906](https://github.com/ever-guild/AgentShelf/commit/9c84906620c3ab6729beaa7995bfca45d6e7731a), run this matrix again against the exact candidate commit before reporting release readiness

Use these results consistently

| Status | Meaning |
| --- | --- |
| `PASS` | The named check ran against the candidate build and its expected evidence was recorded |
| `FAIL` | The check ran and contradicted its expected result |
| `BLOCKED` | The capability, credential, or approved human action needed to run the check is absent |
| `NOT RUN` | The capability exists, but this rehearsal did not execute it |

Do not turn an absent feature into a pass by skipping its row, record the owning issue and the missing prerequisite for every blocked row

Report implementation, automated test execution, runtime wiring, and public deployment as separate evidence, a merged code path does not prove its tests ran, an exported service does not prove a route uses it, and a healthy URL does not prove it serves the candidate commit

## Safe current-code baseline

Use a disposable PostgreSQL 17 database for local rehearsal with `RENDER` unset, Render starts seed an empty database automatically while local seeding remains an explicit step, smoke searches add demand events to the database

Set up the app using [architecture local setup](architecture.md#local-setup), then migrate, seed, and start the app

```bash
npm ci
npm run db:migrate
npm run db:seed
npm run dev
```

With the service running, exercise the current buyer contract

```bash
npm run smoke:demo -- http://localhost:3000/mcp --date 2026-11-06
npm run smoke:mcp -- http://localhost:3000/mcp
```

`smoke:demo` searches both seeded shops and checks the repair slot, it does not create an order or booking but its searches are recorded as demand

`smoke:mcp` initializes the buyer connector, lists the current buyer tools, searches a seeded product, and rejects malformed or tampered checkout input, it never sends a valid checkout

For the current seller UI, sign in at `/seller/sign-in` with the access code for a seeded shop, upload a synthetic CSV such as [`phone-workshop.csv`](../test/fixtures/price-lists/phone-workshop.csv), review the rows, and inspect the published catalog, use a disposable database because this adds catalog rows

This baseline does not exercise new-shop signup, an external seller agent, agent grants, or quantity inventory

## Acceptance matrix

Run the blocked rows after their feature issues merge and the exact contracts are documented, do not invent route or tool names before then

Execution stages separate code-level evidence from browser, agent, and sandbox evidence

| Stage | Evidence type | What it proves |
| --- | --- | --- |
| 1 | Unit tests | Input validation, identity and consent state transitions, idempotency and authorization rules in isolation |
| 2 | PostgreSQL integration tests | Persistence constraints, cross-shop isolation, stock concurrency, webhook deduplication and late-capture transitions |
| 3 | Browser and MCP rehearsal | The shipped owner UI and seller-agent connector work with separate principals against one candidate deployment |
| 4 | PayPal Sandbox | Platform consent and status verification work with a human seller, buyer approval and payment checks happen only in a separately authorized rehearsal |
| 5 | Public deployment verification | Render reports the candidate commit live and the public application responds on the expected URLs |

| ID | Stage | Scenario | Execution and evidence | Current result |
| --- | --- | --- | --- | --- |
| BASE-1 | 3 | Existing two-shop buyer path | Run `smoke:demo`, retain its sanitized output and candidate SHA | `NOT RUN` in this task, helper exists |
| BASE-2 | 3 | Buyer MCP initialization and invalid input | Run `smoke:mcp`, confirm only buyer tools are listed and tampered totals are rejected | `NOT RUN` in this task, helper exists |
| BASE-3 | 3 | Existing seller CSV review and publish | Sign in to a seeded shop, upload the synthetic CSV, edit a row, finish review, and confirm the resulting local product is searchable | `NOT RUN` in this task, current UI exists |
| UI-1 | 3 | Owner registration matches the shared product shell | Complete registration and sign-in on desktop and mobile widths, confirm shared navigation, header, and home styles remain consistent | Shared styles and screens landed in [commit 1a589d7](https://github.com/ever-guild/AgentShelf/commit/1a589d718d19e20f72fac6d68dedcda5372896b1), owner registration remains `BLOCKED` on [seller identity #34](https://github.com/ever-guild/AgentShelf/issues/34), visual rehearsal `NOT RUN` |
| OWNER-1 | 3 | Owner creates a new shop through UI or starts it through their agent, without seeding | Create a fresh shop in a clean database, restart the app, then confirm its owner can still access it and the seed was not needed | `BLOCKED` on [seller identity #34](https://github.com/ever-guild/AgentShelf/issues/34) |
| AGENT-1 | 3 | Seller agent acts independently from the buyer agent | Use the owner's authorized seller-agent credential for a catalog change, use the public buyer connector to find the published result, and record the two principals and shop scopes | `BLOCKED` on [seller MCP #37](https://github.com/ever-guild/AgentShelf/issues/37) |
| AUTH-2 | 2, 3 | Foreign-shop access and revoked seller-agent grant | Attempt a read and a mutation against another shop, revoke the seller-agent grant, then repeat both calls with the old credential | `BLOCKED` on [identity #34](https://github.com/ever-guild/AgentShelf/issues/34) and [seller MCP #37](https://github.com/ever-guild/AgentShelf/issues/37), current per-shop demo sessions have separate tests |
| STOCK-1 | 2, 3 | Quantity change and checkout quantity | Start with three sellable units, buy two under the defined reservation policy, then verify one remains available and the order snapshot records quantity two | `BLOCKED` on [inventory #36](https://github.com/ever-guild/AgentShelf/issues/36) |
| STOCK-2 | 2 | Concurrent buyers compete for the last unit | Start with one available unit and submit two distinct checkout requests concurrently, require exactly one successful reservation and no oversell | `BLOCKED` on [inventory #36](https://github.com/ever-guild/AgentShelf/issues/36) |
| STOCK-3 | 2 | Expired inventory reservation cannot start a new capture | Expire or release a reservation before capture, verify the checkout/payment gate prevents a new PayPal capture request for that reservation | `BLOCKED` on [inventory #36](https://github.com/ever-guild/AgentShelf/issues/36) and [booking hold capture gate #38](https://github.com/ever-guild/AgentShelf/issues/38) |
| STOCK-4 | 2 | Already captured payment arrives after inventory reservation expires | Reconcile the late verified capture as `review_required`, retain evidence for seller resolution, and do not consume stock or allow a second buyer to double-book it | `BLOCKED` on [inventory #36](https://github.com/ever-guild/AgentShelf/issues/36) and [booking hold capture gate #38](https://github.com/ever-guild/AgentShelf/issues/38) |
| PAYPAL-1 | 1, 2 | Shop has no PayPal connection | Create a shop without PayPal consent, confirm catalog work succeeds, checkout returns the documented not-connected state, and no provider order or approval link is created | Current checkout has a tested `PAYMENT_NOT_CONFIGURED` boundary, new shop onboarding behavior is `BLOCKED` on [PayPal onboarding #35](https://github.com/ever-guild/AgentShelf/issues/35) |
| PAYPAL-2 | 4 | Incomplete or revoked PayPal consent | Stop between consent start and return, then revoke consent, confirm both states block new checkout without exposing app secrets | `BLOCKED` on [PayPal onboarding #35](https://github.com/ever-guild/AgentShelf/issues/35) |
| PAY-1 | 2 | Duplicate webhook delivery | Deliver the same verified fixture twice through the database-backed webhook test harness, require one payment transition and one receipt | Existing behavior is covered by [`paypal-webhook.db.test.ts`](../src/server/services/paypal-webhook.db.test.ts), rerun on the release candidate |
| PAY-2 | 2 | Do not capture after a booking hold expires or is cancelled | Expire or cancel the hold before capture, verify the payment path makes no PayPal capture call for that hold | Guard implemented with database coverage in [commit db9293c](https://github.com/ever-guild/AgentShelf/commit/db9293c77dc7dd48026276f6cb5efd43a3e240ad), release-candidate test `NOT RUN` |
| PAY-3 | 2 | PayPal capture was already completed after a booking hold expires | Use a verified late-capture fixture and controlled clock, require `review_required` with capture evidence recorded and the booking not confirmed, do not double-book the slot | Late-capture transition is covered by [`bookings.db.test.ts`](../src/server/services/bookings.db.test.ts) and was extended in [commit db9293c](https://github.com/ever-guild/AgentShelf/commit/db9293c77dc7dd48026276f6cb5efd43a3e240ad), release-candidate test `NOT RUN` |
| DEPLOY-1 | 5 | Candidate is live at the public demo | Confirm Render reports `live` for the exact candidate SHA, then check homepage and health/readiness URLs and record sanitized results | `NOT RUN` in this task, see [CI deploy workflow](../.github/workflows/ci.yml) for automated commit verification |

`PAY-1` and `PAY-3` are automated stand-in checks, they are not evidence of a real PayPal webhook or transaction

## Evidence record

For each rehearsal record the candidate commit, database type, command or manual path, result, sanitized output, and any issue blocking the check

Never record a buyer password, seller credential, access token, PayPal approval URL, payer data, or raw webhook body in the evidence

Do not run `smoke:checkout`, `smoke:booking`, or the import smoke against a shared demo as part of this safe baseline, those commands create a sandbox order, hold an appointment, or upload data, complete the actual sandbox payment only during the separately approved end-to-end payment rehearsal

## Cross-issue handoff

The owner and seller-agent work should reuse the catalog service and align its changes with [#9](https://github.com/ever-guild/AgentShelf/issues/9), search indexing with [#10](https://github.com/ever-guild/AgentShelf/issues/10), capture and verified webhook transitions with [#11](https://github.com/ever-guild/AgentShelf/issues/11), and booking hold policy with [#12](https://github.com/ever-guild/AgentShelf/issues/12)

The storefront checkout in [#16](https://github.com/ever-guild/AgentShelf/issues/16) must consume the same stock reservation contract as buyer MCP, the two-shop fixtures remain in [#17](https://github.com/ever-guild/AgentShelf/issues/17)

The release gate in [#18](https://github.com/ever-guild/AgentShelf/issues/18) also depends on the booking capture guard in [#38](https://github.com/ever-guild/AgentShelf/issues/38) and shared-screen design pass in [#39](https://github.com/ever-guild/AgentShelf/issues/39), keep the booking rule explicit: no new capture after a hold expires or is cancelled, an already completed late capture stays under review and never confirms or double-books the slot

Do not change another issue's ownership or implementation as part of rehearsal preparation, send contract changes to the issue owner for review
