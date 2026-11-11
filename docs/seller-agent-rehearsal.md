# Seller-agent runtime rehearsal

## Recorded evidence

The [runtime baseline](https://github.com/ever-guild/AgentShelf/commit/8b6e6d4834c6b94989db575064a1569f30ecedd6) passed 1,496 tests, lint, production build and the complete local HTTP/MCP scenario on a fresh database with PayPal, Anthropic and Render environment settings absent

Real Chrome verified owner registration, catalog access, mobile width, seller-header sign-out and legacy sign-in on the [identity candidate](https://github.com/ever-guild/AgentShelf/commit/e0e1004dad7be3465b94dce08486f5c953d17d5a), follow [PR #43](https://github.com/ever-guild/AgentShelf/pull/43) for subsequent review fixes

Record the exact revision for every later run in [release rehearsal #18](https://github.com/ever-guild/AgentShelf/issues/18); these dated results alone do not establish real Sandbox payments or an external assistant session, which are recorded separately in the matrix below

A clean local run on 9 November 2026 at `37fea91` repeated the setup below with Node.js 24 and PostgreSQL 17 in Docker and no provider settings: `smoke:runtime` passed every check, including `PAYMENT_NOT_CONFIGURED` for the unconnected shop

## Local setup

Use Node.js 24 and PostgreSQL 17, create a new disposable database and leave `RENDER` unset, follow the [local setup](../DEVELOP.md#run-locally) and [architecture](architecture.md)

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
- After owner sign-in and selecting the shop, expect to land on `/seller/assistant` with the shop's `/mcp/seller/shop/<shop-id>` address; the menu reads Assistant, Price lists, Catalog, Schedule, Dashboard
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
| Platform payment webhook | Signature-first verification, identifier agreement, deduplication and revoked-completed order | Suite `implemented`. Real delivery: one event chain verified on 8 November 2026 for one EUR 1 order ([sandbox proof](paypal-sandbox-proof.md)). Webhook receipts for the 9 November rehearsal captures are not proven; the buyer return captured first and stored receipts were not read |
| Sandbox seller/payment flow | Two consents, approval, recipient, capture and both webhook subscriptions | Two owner shops ready with different merchants ([#35](https://github.com/ever-guild/AgentShelf/issues/35)); one human-approved EUR 1 checkout captured for the right seller with both platform webhooks verified for that order ([#2](https://github.com/ever-guild/AgentShelf/issues/2)), 8 November 2026. A 20 EUR booking deposit was approved and captured in the 9 November hosted rehearsals on `d908114` ([#18](https://github.com/ever-guild/AgentShelf/issues/18#issuecomment-6751024359)) |
| External seller assistant | Real configured-client session performing seller tools | `external client verified`: PASS with Claude Code 2.1.319 on the deployed demo at `0c8e262`, 8 November 2026, see [below](#external-claude-code-session). Claude Code only; no PayPal connection, order or capture in that run |
| Owner walkthrough on the hosted demo | Register or sign in, select shop, `/seller/assistant`, issue a credential in `/seller/agent-access`, connect an agent, give PayPal consent on `/seller/paypal-connection`, revoke | `not recorded` as one run. Parts: registration, catalog access and the per-shop consent reset have Chrome PASS at the revisions above. The 8 November Claude Code run obtained its grants from the `/api/seller/identity/*` endpoints that the page calls, not by clicking the page, and it had no PayPal connection. Using the page or the PayPal consent from an agent session is open, see [owner-run checklist](#owner-run-checklist) |
| Seller agent and buyer agent in one scenario | The seller agent sets or adjusts stock on a PayPal-connected shop, a buyer assistant buys it, stock drops by one | `not recorded` as one chain. Separately: seller-agent stock 3 to 2 on a shop without PayPal (8 November, below); a buyer Claude Code purchase on the connected rehearsal shop with stock 2 to 1 ([mcp.md](mcp.md#status), 9 November). The seller agent did not set that stock. Open, see [owner-run checklist](#owner-run-checklist) |
| Public deployment | Exact Render live SHA plus health and functional checks | Runtime integrated in main. Deployed demo at `0c8e262` for the 8 November Claude Code run; `d908114` for the 9 November rehearsals; `198bc1f` for the read-only check of 10 November ([mcp.md](mcp.md#status)). Record the live SHA from `/api/health` for each later run in [#18](https://github.com/ever-guild/AgentShelf/issues/18) |

For an actual Sandbox rehearsal, follow [Sandbox setup](paypal-sandbox-setup.md), [merchant connection](paypal-merchant-connection.md) and [inventory behavior](inventory-contract.md), use separate subscription IDs for consent revocation and platform payment events

## External Claude Code session

Evidence level: `external client verified`, Claude Code 2.1.319 only. The "Result" column records what the tool returned; a row that reads `not_configured` is not a pass.

On 8 November 2026 Claude Code 2.1.319 ran the seller scenario against the deployed demo at [`0c8e262`](https://github.com/ever-guild/AgentShelf/commit/0c8e26249c92b97428c01a2816cf22ed15fe7688) in non-interactive sessions (`claude -p --mcp-config --strict-mcp-config`, `http` transport, `Authorization` header from an environment variable). Every tool call below was issued by the client; the owner session and grants came from the documented `/api/seller/identity/*` owner endpoints used by `/seller/agent-access`.

| Step | Tool or check | Result |
| --- | --- | --- |
| Owner | Account-only registration of a synthetic owner, `create_shop` grant | 201, 201 |
| Discovery on `/mcp/seller/onboarding` | Server status and tools | Connected, only `seller_create_shop` |
| Create shop | `seller_create_shop` once with an idempotency key | Synthetic test shop created, `paymentStatus: "not_configured"` |
| Shop grant | `read_shop`, `manage_catalog`, `manage_inventory` | 201, five shop tools listed |
| Import | `seller_import_price_list`, two-row test CSV, called once | `needs_review` |
| Review | `seller_review_import` `get`, `edit_row` for the missing price, `accept_clean`, `get`, `publish` | Blocker cleared, both rows accepted, `publishedCount: 2` |
| Catalog | `seller_manage_catalog` `list` | Both products published. PayPal Catalog sync showed `not_configured`, which is expected here: this test shop had no PayPal connection (`paymentStatus: "not_configured"` above). It is not a pass and says nothing about platform-connected shops. In code, `not_configured` is written only when no PayPal sender is available at that moment, a PayPal error on send is `failed`, |
| Stock before policy | `seller_manage_stock` `read` | `NOT_FOUND`, the product had no inventory policy |
| Stock | `set_mode` tracked 3, `read`, `adjust` -1 with version 0, `read` | 3 at version 0, then 2 at version 1 |
| Stale version | `adjust` again with version 0 | `CONFLICT`, quantity unchanged |
| Untracked | `set_mode` untracked on the second product | Untracked, version 0 |
| Foreign shop | Same grant on a seeded shop's URL | Server failed with `AUTH_HEADER_REJECTED` (HTTP 401), no tools |
| Read-only grant | `read_shop` grant: stock `read`, `adjust`, catalog `unpublish`, catalog `list` | Read allowed; adjust, unpublish and list `UNAUTHORIZED` |
| Cleanup | `seller_manage_catalog` `unpublish` both products | Both unpublished |
| Revocation | Same client with the revoked shop grant and the revoked `create_shop` grant | Both fail with HTTP 401 |
| Buyer route | Claude Code connected to `/mcp`, no tool called | Connected, the five buyer tools listed |

No PayPal connection, order, capture or refund was attempted. Before this run, failed stock and scope calls returned only a generic message; seller MCP errors now carry fixed recovery guidance per code. That change is verified by contract tests and is not part of the deployed `0c8e262` run.

## Owner-run checklist

For the two `not recorded` rows. Each step needs the owner or a Sandbox buyer; none needs a server credential, and no agent approves a payment. Use a shop you own and PayPal Sandbox accounts only.

1. As the owner, register or sign in, select the shop and confirm `/seller/assistant` shows its address.
2. On `/seller/agent-access` tick the permissions the task needs (including **Manage inventory**), press **Review and issue credential** and give the credential only to your agent, as in [seller MCP setup](seller-agent-mcp.md#connect-claude-code).
3. For PayPal consent either press **Start sandbox connection** on `/seller/paypal-connection` or let the agent call `seller_connect_paypal` under a `connect_paypal` grant, then finish the PayPal Sandbox steps yourself. Pass only if the page shows **Connected** (connection status `ready`).
4. Ask the agent to read stock for one product with `seller_manage_stock`. For a product without a policy, use `set_mode` tracked with a count; for an existing tracked product, use a versioned adjustment if needed. Do not switch an existing policy just for this check. Note the count and `version`.
5. In a separate buyer assistant ([buyer quickstart](buyer-quickstart.md)) search that product, create one checkout, approve it in PayPal Sandbox as the buyer, and wait until `get_order_status` reports `paid`.
6. Read the stock again through the agent or `/seller/catalog`. Pass only if it dropped by exactly one and the order is `paid`.
7. Revoke each credential with **Revoke credential** and confirm the agent's next call fails with HTTP 401.

Record the live commit from `/api/health`, UTC times, the clients and the result of each step, and keep payer data, approval links and credentials out of the record. A link returned by `create_checkout` or `seller_connect_paypal` is not proof of payment or consent.

## Evidence record

Record revision, database type, command or manual action, result and remaining blocker, keep test fixtures, browser actions, real PayPal operations and deployment checks separate

Never include passwords, cookies, raw grants, approval URLs, payer data, raw webhook bodies or secret values, do not run order or booking smoke against a shared demo without its explicitly authorized rehearsal scope

Feature ownership remains in [registration #34](https://github.com/ever-guild/AgentShelf/issues/34), [merchant connection #35](https://github.com/ever-guild/AgentShelf/issues/35), [inventory #36](https://github.com/ever-guild/AgentShelf/issues/36) and [seller MCP #37](https://github.com/ever-guild/AgentShelf/issues/37), release evidence belongs in [#18](https://github.com/ever-guild/AgentShelf/issues/18) and the reproducible guide in [#19](https://github.com/ever-guild/AgentShelf/issues/19)
