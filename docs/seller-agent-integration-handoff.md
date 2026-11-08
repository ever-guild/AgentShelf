# Seller-agent runtime integration handoff

## Delivery and evidence

This change connects owner registration, seller-agent management, quantity inventory and PayPal Sandbox merchant connections to the application

The [runtime baseline](https://github.com/ever-guild/AgentShelf/commit/8b6e6d4834c6b94989db575064a1569f30ecedd6) passed 1,496 tests across 77 files, lint, production build and the complete local HTTP/MCP rehearsal on a fresh PostgreSQL database without PayPal or Anthropic credentials

The [identity candidate](https://github.com/ever-guild/AgentShelf/commit/e0e1004dad7be3465b94dce08486f5c953d17d5a) separately passed real Chrome registration, shop selection, catalog access, the visible seller-header sign-out and subsequent legacy sign-in, see [PR #43](https://github.com/ever-guild/AgentShelf/pull/43)

Subsequent review fixes cover the registration limit, per-shop consent acknowledgement and the platform payment webhook, their exact validation and publication state are recorded in [release rehearsal #18](https://github.com/ever-guild/AgentShelf/issues/18), real Sandbox consent/payment and external assistant evidence remain separate gates

## Identity and owner access

| Page | Purpose |
| --- | --- |
| `/seller/register` | Create an owner account, optionally with a first shop |
| `/seller/owner-sign-in` | Sign in to an existing owner account |
| `/seller/shops` and `/seller/shops/new` | Select an owned shop or create another |
| `/seller/agent-access` | Issue and revoke scoped agent grants |
| `/seller/paypal-connection` | Start human Sandbox consent and inspect verified connection state |

HTTP identity operations live under `/api/seller/identity/*`, the owner session expires after 12 hours and the selected-shop cookie is checked against current membership on each request

An owner cookie takes precedence over the legacy access-code session, an invalid owner session cannot fall back to another shop, both the owner and existing seller-header logout paths revoke owner access, successful legacy sign-in clears the previous owner context

Account-only signup supports an agent creating the first shop, passwords are hashed, sessions and grants are stored by token hash, the registration API uses a shared bounded attempt bucket and an additional account bucket

## Seller MCP contract

| Route | Authorization | Operations |
| --- | --- | --- |
| `POST /mcp/seller/onboarding` | Owner-level `create_shop` grant | `seller_create_shop` only |
| `POST /mcp/seller/shop/{shopId}` | Live grant for the exact shop | Import, review, catalog, stock and PayPal tools according to scope |
| `POST /mcp` | Existing buyer connector | Search, slots, booking, checkout and order status |

Grants expire after 15 minutes, the raw token is returned once and can be revoked, a `create_shop` grant binds its first successful use to one idempotency key and requires a separate shop-bound grant for subsequent management

Seller authorization comes from the bearer header and persisted grant, tool arguments cannot supply the owner, shop authority, PayPal recipient, credentials or consent evidence, the transport validates Host, Origin, request size and active authorization before discovery

Import produces a draft, publication requires review, new products use the import/review path and existing catalog actions support list, edit, publish and unpublish, stock actions support reading, explicit policy selection and versioned adjustments

The supported configured-client path is documented in [seller MCP](seller-agent-mcp.md), an actual Claude Code session is recorded in the [rehearsal](seller-agent-rehearsal.md#external-claude-code-session), ChatGPT seller OAuth is not supported

## Migrations and inventory

Apply the normal migration journal, do not separately execute draft SQL

| Migration | Result |
| --- | --- |
| [0011](../drizzle/0011_identity_registration.sql) | Owners, memberships, sessions, grants and attempt limits |
| [0012](../drizzle/0012_paypal_merchant_connections.sql) | Merchant connections, consent evidence and revocation ledger |
| [0013](../drizzle/0013_inventory_stock_reservations.sql) | Stock, reservations, order links and immutable audit |
| [0014](../drizzle/0014_order_paypal_credential_snapshot.sql) | Original PayPal credential reference per order, with legacy backfill |
| [0015](../drizzle/0015_legacy_and_demo_inventory.sql) | Audited untracked policy for legacy manual products |

New products without a stock policy cannot be purchased, `tracked` availability is on-hand minus reserved quantity, `untracked` records an explicit decision to sell without quantity accounting

The seed assigns audited synthetic quantities only to fixed demo product IDs, rerunning it preserves existing stock, versions and reservations, imported products do not acquire an implicit unlimited quantity

A physical checkout writes the order, line snapshots and reservation in one transaction before contacting PayPal, capture requires a live allocation and current platform consent when applicable

An ambiguous capture keeps stock held and is read again without blindly resending capture, a verified completed capture uses the provider timestamp, late or inconsistent evidence requires review, refunds do not automatically restock

The repair booking hold remains separate, its expiry/capture policy and paid-booking replay are preserved, both physical and booking orders retain the original app reference and payee for reconciliation

## PayPal connection and payment events

An owner acknowledges data sharing for the selected shop, or explicitly delegates `connect_paypal` with that acknowledgement, the server preserves the original acknowledgement timestamp separately from connection initiation

The agent can return the human Sandbox consent URL, merchant permission approval stays with the human in PayPal, callback hints alone cannot establish readiness

Checkout and catalog sync resolve a persisted ready connection with verified merchant, tracking, receiving, email, product and scope evidence, platform Orders and Catalog calls include the seller assertion and partner attribution headers

| Configuration | Purpose |
| --- | --- |
| `PAYPAL_PLATFORM_CLIENT_ID`, `PAYPAL_PLATFORM_CLIENT_SECRET` | Server-side Sandbox platform app |
| `PAYPAL_PLATFORM_MERCHANT_ID`, `PAYPAL_PARTNER_ATTRIBUTION_ID` | Partner operations and attribution |
| `PAYPAL_PLATFORM_WEBHOOK_ID` | Consent-revocation subscription at `/api/seller/paypal/connection/webhook` |
| `PAYPAL_PLATFORM_PAYMENT_WEBHOOK_ID` | Payment subscription at `/api/paypal/platform-webhooks` |
| `PAYPAL_CLIENT_ID_<REF>`, `PAYPAL_CLIENT_SECRET_<REF>`, `PAYPAL_WEBHOOK_ID_<REF>` | Existing direct seller app configuration |

Payment events are verified against the fixed platform subscription before a receipt is written, routing requires a stored platform order and consistent identifiers, reconciliation uses the saved payee even after revocation while prohibiting a fresh unauthorized capture

Consent revocation is recorded even when merchant mapping has not arrived yet, stale callback/status responses cannot restore readiness over a newer revocation

Keep values only in ignored local configuration or deployment secrets, follow the [Sandbox setup](paypal-sandbox-setup.md) for the two subscriptions and [merchant connection contract](paypal-merchant-connection.md) for authorization behavior

## Remaining release gates

- Actual platform app permissions, two human seller consents and buyer-approved Sandbox payment with verified recipient and capture in [proof #2](https://github.com/ever-guild/AgentShelf/issues/2)
- Actual delivery of both webhook subscriptions, including revocation and payment reconciliation
- External seller assistant: Claude Code passed the documented connector scenario on the deployed demo, see [rehearsal](seller-agent-rehearsal.md#external-claude-code-session)
- Shared integration review, exact-SHA CI and Render verification after main integration
- The complete rehearsal and evidence requested by [#18](https://github.com/ever-guild/AgentShelf/issues/18) and [#19](https://github.com/ever-guild/AgentShelf/issues/19)

Use the [rehearsal guide](seller-agent-rehearsal.md) to reproduce local checks, keep implementation, test fixtures, real provider behavior and deployment evidence distinct
