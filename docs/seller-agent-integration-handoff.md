# Seller-agent runtime integration handoff

## Candidate snapshot

This handoff reflects the combined review candidate at [`b31ca1b`](https://github.com/ever-guild/AgentShelf/commit/b31ca1b535b43f4eccdd29582a7bf0dabbb070f8), inspected on 6 November 2026. That worktree is a review candidate, not `main` and not the deployed demo.

The candidate contains ordered migrations [`0011_identity_registration.sql`](../drizzle/0011_identity_registration.sql), [`0012_paypal_merchant_connections.sql`](../drizzle/0012_paypal_merchant_connections.sql), [`0013_inventory_stock_reservations.sql`](../drizzle/0013_inventory_stock_reservations.sql), [`0014_order_paypal_credential_snapshot.sql`](../drizzle/0014_order_paypal_credential_snapshot.sql), and [`0015_legacy_and_demo_inventory.sql`](../drizzle/0015_legacy_and_demo_inventory.sql). They add owner identity and grants, shop PayPal connection state, stock and reservations, immutable PayPal credential selection per order, and safe legacy/demo stock initialization.

The independent [identity PR #43](https://github.com/ever-guild/AgentShelf/pull/43) has green CI. The [seller MCP SDK check for #41](https://github.com/ever-guild/AgentShelf/commit/35471cd42364a34bb55588208068fc75370d0144) was run against that exact commit. Final candidate QA for the new negative-checkout path and header/logout compatibility is still pending. Neither result is evidence of a deployed candidate, an external Claude Code session, or a real PayPal operation.

## Owner account and shop access

The owner UI is present in the candidate:

- `/seller/register` creates an owner account, with an optional first shop.
- `/seller/owner-sign-in` signs in the owner.
- `/seller/shops` lists and selects owned shops; `/seller/shops/new` adds a shop.
- `/seller/agent-access` issues and revokes seller-agent grants.
- `/seller/paypal-connection` starts and checks a shop's PayPal Sandbox connection.

Identity HTTP routes live under `/api/seller/identity/*`. The `agentshelf_owner_session` cookie authenticates the owner; `agentshelf_owner_shop` is a selector, not an authorization boundary. Each request checks current owner membership. Owner sessions expire after 12 hours. The old seeded-shop access-code session remains a separate demo path.

Owner grants expire after 15 minutes and are stored by token hash. The raw grant is returned once, is not listable or recoverable, and can be revoked by its owner. An owner-level `create_shop` grant can create one shop; it does not authorize later shop management. The owner issues a separate shop-bound grant for `read_shop`, `manage_catalog`, `manage_inventory`, or `connect_paypal`. `connect_paypal` requires explicit owner consent, persisted with the grant; the MCP tool cannot add or broaden that consent.

## Seller MCP runtime

The buyer connector remains at `POST /mcp`. Seller tools use separate Streamable HTTP routes:

| Route | Grant | Available tool |
| --- | --- | --- |
| `POST /mcp/seller/onboarding` | Owner-level `create_shop` | `seller_create_shop` only |
| `POST /mcp/seller/shop/{shopId}` | Active grant for that exact shop | `seller_import_price_list`, `seller_review_import`, `seller_manage_catalog`, `seller_manage_stock`, `seller_connect_paypal`, subject to scope and configured adapters |

The transport reads the bearer grant from the `Authorization` header. Shop identity is derived from the route and rechecked against the grant; tool arguments cannot set the shop, owner, actor, PayPal recipient, or credentials. The transport checks `Host`, allowed `Origin`, DNS rebinding and request size. The onboarding grant cannot call a shop-management route, and an expired or revoked grant is rejected.

Import creates a reviewable draft; an owner or authorized agent must review it before publication. Current catalog actions are list, edit, publish and unpublish; new products use the import and review flow. `seller_manage_stock` reads stock, records the initial policy, and makes versioned adjustments. `seller_connect_paypal` starts the human consent flow and returns a Sandbox action link only when the grant carries the owner's recorded consent.

See [the seller MCP contract](seller-agent-mcp.md), [identity contract](seller-identity.md), and [owner-led rehearsal](seller-agent-rehearsal.md) for exact schemas and commands.

## Stock and physical checkout

Inventory now reaches the shared buyer checkout service. Both buyer MCP `create_checkout` and the human storefront use that service. For a physical product, it writes the order, immutable line snapshots and stock reservation in one PostgreSQL transaction before creating a PayPal approval link. A cart quantity is an integer; unavailable or undecided stock fails closed.

`tracked` stock has `on_hand`, `reserved`, and `available = on_hand - reserved`. `untracked` means the seller explicitly chose not to track a quantity; it is not zero. No stock row means the seller has not made a policy decision. Initial policy and later adjustments are audited and idempotent; adjustments use a version and reason.

Before capture, reconciliation must atomically claim the live reservation's one capture attempt. An ambiguous provider result keeps the reservation while the existing order is checked. A verified capture is matched to the stored order and its provider timestamp. A completed capture after expiry goes to `review_required`, does not consume stock or fulfill the order, and keeps held quantity reserved for a person to resolve. Release requires a verified unpaid, cancelled or expired-unpaid outcome. Refund does not restock automatically.

The physical-order capture gate is distinct from the repair-booking time hold. The existing booking rule still prevents a new deposit capture after its hold expires; an already completed late deposit remains under review and does not confirm or double-book the appointment.

## PayPal Sandbox connection and consent

Owner HTTP routes are mounted under `/api/seller/paypal/connection`; the seller MCP composition uses the same connection service. The owner selects a shop and checks an explicit data-sharing acknowledgement before the server starts Partner Referrals. The agent cannot self-consent. The seller finishes account consent on PayPal; a callback hint alone is not proof of readiness. The server verifies the returned merchant integration, consent, receiving capability, primary email, product and payment scope before marking the connection `ready`. Checkout uses the verified seller merchant as payee and requires that current ready state. The buyer still approves payment in PayPal.

The platform integration uses one server-only PayPal Sandbox REST app. Safe variable names are listed in [`.env.example`](../.env.example):

| Variable | Use |
| --- | --- |
| `PAYPAL_PLATFORM_CLIENT_ID` and `PAYPAL_PLATFORM_CLIENT_SECRET` | Platform REST app's server-side Sandbox OAuth |
| `PAYPAL_PLATFORM_MERCHANT_ID` | Partner Referrals and merchant-status requests |
| `PAYPAL_PARTNER_ATTRIBUTION_ID` | Partner attribution header |
| `PAYPAL_PLATFORM_WEBHOOK_ID` | Verification of PayPal seller-consent revocation events |
| `PAYPAL_CLIENT_ID_<REF>`, `PAYPAL_CLIENT_SECRET_<REF>`, `PAYPAL_WEBHOOK_ID_<REF>` | Existing per-seller Sandbox app and order-webhook configuration for legacy/demo routes |

The UI and API expose configuration presence/status only. Keep all values in ignored `.env.local` or the deployment secret store; never put credentials, grant tokens, approval URLs, or payer data in these notes. `PAYPAL_PLATFORM_WEBHOOK_ID` handles platform consent revocation; it is not a substitute for the per-seller order webhook ID. The actual platform app configuration, merchant authorization, referral, webhook delivery, buyer approval, and capture have not been verified against PayPal Sandbox in this candidate.

## Evidence and remaining checks

Implementation, automated tests, runtime execution, external clients, Sandbox behavior and deployment are separate claims. At this snapshot:

- Owner, seller MCP, inventory and PayPal connection routes are present and wired in the review candidate.
- Identity PR #43 CI and the exact #41 SDK check at `35471cd` are recorded above; the combined candidate still needs its final negative-checkout and header/logout QA.
- A local `smoke:runtime` exercises owner signup/sign-in, grant boundaries, seller import/review/catalog/stock tools, buyer search, an expected `PAYMENT_NOT_CONFIGURED` checkout rejection, cross-shop denial, grant revocation and owner sign-out. It creates synthetic persistent rows and requires a disposable database; its run result must be recorded against the exact candidate SHA.
- Real PayPal Sandbox onboarding/webhook/payment checks and a real external Claude Code MCP session remain unverified.
- The candidate has not been merged to `main` or confirmed live on Render.

Release rehearsal is tracked in [#18](https://github.com/ever-guild/AgentShelf/issues/18) and [#19](https://github.com/ever-guild/AgentShelf/issues/19). Feature context is tracked in [owner identity #34](https://github.com/ever-guild/AgentShelf/issues/34), [PayPal onboarding #35](https://github.com/ever-guild/AgentShelf/issues/35), [inventory #36](https://github.com/ever-guild/AgentShelf/issues/36), and [seller MCP #37](https://github.com/ever-guild/AgentShelf/issues/37). The exact candidate SHA, checks, human approvals and deployment evidence belong in the rehearsal record, not inferred from this integration note.
