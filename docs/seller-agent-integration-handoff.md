# Seller-agent integration handoff: shared contracts

## Purpose

This note identifies existing product files that the owner, seller-agent, inventory, and PayPal onboarding work will need to integrate with

It records technical seams only, it does not state that another issue owner has reviewed or approved these changes

## Current contracts reviewed

The seller MCP draft in issue [#37](https://github.com/ever-guild/AgentShelf/issues/37) exposes `seller_create_shop`, `seller_import_price_list`, `seller_review_import`, `seller_manage_catalog`, `seller_manage_stock`, and `seller_connect_paypal`, shop identity comes from the verified grant context rather than tool arguments, an authorized catalog edit may submit a candidate price for validation but caller data cannot set the payment authority, recipient, or charged amount outside the stored catalog quote

The inventory draft in issue [#36](https://github.com/ever-guild/AgentShelf/issues/36) defines shop-scoped stock levels, versioned adjustments, idempotency, reservations, commit, release, and review-required transitions

The identity and seller MCP drafts in issues [#34](https://github.com/ever-guild/AgentShelf/issues/34) and [#37](https://github.com/ever-guild/AgentShelf/issues/37) now align on an owner-level `create_shop` grant and membership-bound shop scopes `read_shop`, `manage_catalog`, `manage_inventory`, and `connect_paypal`, creating a shop does not grant the agent permission to manage it and the owner must explicitly issue a separate grant

The PayPal platform draft in issue [#35](https://github.com/ever-guild/AgentShelf/issues/35) keeps shop connection state separate from AgentShelf shop identity, requires explicit owner consent and verified merchant status, and leaves checkout, capture, and webhook integration in their existing service boundaries

Booking hold capture prevention is implemented in [commit db9293c](https://github.com/ever-guild/AgentShelf/commit/db9293c77dc7dd48026276f6cb5efd43a3e240ad) for the booking deposit flow and tracked in [issue #38](https://github.com/ever-guild/AgentShelf/issues/38), do not issue a new capture after the hold expires or is cancelled, if PayPal has already completed capture reconcile it as `review_required` without confirming the booking or double-booking its slot, the inventory reservation gate still needs equivalent checkout wiring

The shared app shell, navigation, header, sign-in, and home design pass tracked in [issue #39](https://github.com/ever-guild/AgentShelf/issues/39) is present in [commit 1a589d7](https://github.com/ever-guild/AgentShelf/commit/1a589d718d19e20f72fac6d68dedcda5372896b1), the new owner registration interface still needs to be designed and checked against that shell

These are independent module contracts, the exact candidate must still be checked for runtime routes, service wiring, automated test execution, and deployment evidence

In the reviewed worktrees, seller tools have a server contract and a separate transport file, while the current `/mcp` route still constructs the buyer server; inventory has database operations but checkout and buyer MCP do not yet call its reservation service; PayPal has a merchant-connection domain module but no platform consent API route is wired

Local product publication is already independent of PayPal Catalog Products sync, [`seller-catalog.ts`](../src/server/services/seller-catalog.ts) marks the local product published and the buyer catalog reads local publication state, provider synchronization is a separate follow-up operation

## Existing integration points

| Existing file | Why the new work touches it | Contract to preserve |
| --- | --- | --- |
| [`src/server/db/schema.ts`](../src/server/db/schema.ts) | Shared shop, product, and order persistence currently lives here | Keep owner membership, grant, connection, inventory, and commerce relationships tenant-bound and uniquely constrained |
| [`src/server/auth/current-seller.ts`](../src/server/auth/current-seller.ts) and [`src/server/auth/seller-session.ts`](../src/server/auth/seller-session.ts) | Existing seller routes derive their principal from the seeded-shop access-code session | Do not treat the demo session as an owner account or seller-agent grant, add explicit principal resolution at the route/service boundary |
| [`src/server/contracts/seller-catalog.ts`](../src/server/contracts/seller-catalog.ts) and [`src/server/services/seller-catalog.ts`](../src/server/services/seller-catalog.ts) | The seller UI and APIs already create and update local products | Seller MCP and new owner UI should reuse this local catalog behavior and its shop ownership checks |
| [`src/server/services/imports.ts`](../src/server/services/imports.ts), [`src/server/services/import-start.ts`](../src/server/services/import-start.ts), and [`src/server/services/import-run.ts`](../src/server/services/import-run.ts) | Import upload, extraction, review, and publication are already implemented as services | Seller tools must reuse import ownership and review state, they must not publish unreviewed extraction output |
| [`src/server/services/catalog.ts`](../src/server/services/catalog.ts) and [`src/server/services/search-index.ts`](../src/server/services/search-index.ts) | Local publication and buyer search indexing are separate from provider catalog synchronization | A product becomes discoverable from AgentShelf's local publication/index state, PayPal Catalog Products sync is optional provider metadata and is not the local publish gate |
| [`src/server/mcp/server.ts`](../src/server/mcp/server.ts) and [`src/app/mcp/route.ts`](../src/app/mcp/route.ts) | These files implement the public buyer MCP connector and its HTTP transport | Keep buyer tools separate from seller management tools, do not add shop-management arguments to the unauthenticated buyer contract |
| [`src/server/services/checkout-quote.ts`](../src/server/services/checkout-quote.ts) and [`src/server/services/checkout.ts`](../src/server/services/checkout.ts) | Checkout validates the server-side price and creates provider orders | Inventory reservation must be atomic with quote/checkout policy, price and PayPal recipient remain server-derived |
| [`src/server/services/payment-reconciliation.ts`](../src/server/services/payment-reconciliation.ts), [`src/server/services/paypal-webhook.ts`](../src/server/services/paypal-webhook.ts), and [`src/app/api/paypal/webhooks/[slug]/route.ts`](../src/app/api/paypal/webhooks/%5Bslug%5D/route.ts) | Capture outcomes, verified events, duplicate delivery, and late payment handling converge here | Add a pre-capture gate for expired or cancelled holds, keep already completed late captures in review, connect inventory commit/release/review transitions without weakening webhook deduplication |
| [`src/server/paypal/orders.ts`](../src/server/paypal/orders.ts) | Orders v2 authentication, payee validation, approval, and capture are centralized here | A connected seller mapping selects the merchant, human approval remains required, a platform assertion must match the same shop and order payee |
| [`src/server/services/storefront.ts`](../src/server/services/storefront.ts) and [`src/app/api/shops/[slug]/checkout/route.ts`](../src/app/api/shops/%5Bslug%5D/checkout/route.ts) | Human storefront checkout is a second buyer path | It must share the same stock availability and reservation rules as buyer MCP checkout |
| [`drizzle/0001_invariants.sql`](../drizzle/0001_invariants.sql) and [`drizzle/0008_search_vectors.sql`](../drizzle/0008_search_vectors.sql) | Existing schema constraints and search indexing are migration-owned | Add forward migrations for durable state, do not edit an already-applied migration in place |

## Integration order

1. Implement the now-aligned principal contract between [#34](https://github.com/ever-guild/AgentShelf/issues/34) and [#37](https://github.com/ever-guild/AgentShelf/issues/37), including grant issuance, tenant scope, revocation, and which seller operations require each scope
2. Connect seller tools to the existing import and catalog services, then prove local publication reaches buyer search without requiring PayPal catalog sync
3. Connect inventory state to both MCP and storefront checkout, then prove reservation, idempotent settlement, and failure/release behavior against PostgreSQL
4. Connect PayPal status to the existing order service only after the shop's platform consent and merchant status are verified, keep human approval and webhook reconciliation as explicit gates
5. Keep the booking capture gate in [#38](https://github.com/ever-guild/AgentShelf/issues/38) in regression coverage, distinguish blocked new capture from late provider capture that requires review
6. Integrate the registration experience with the shared screen design in [#39](https://github.com/ever-guild/AgentShelf/issues/39), then run the stage-specific acceptance rows in [the rehearsal matrix](seller-agent-rehearsal.md) and label unit/database evidence separately from browser/MCP and real Sandbox evidence

## Limits

No live transaction, valid buyer checkout, deployment, or remote mutation is part of this handoff

The current demo seller access code is not an owner identity, tool arguments must not choose the shop scope, actor, payment credential, PayPal recipient, or charged amount, an authorized catalog edit may submit a candidate price that the shop-scoped catalog service validates and stores, checkout must derive the payable amount from its stored server-side quote
