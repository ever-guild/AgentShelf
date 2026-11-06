# Quantitative inventory contract (#36)

This is the standalone domain module and a migration draft. It is not wired into checkout,
catalog imports, seller routes, seller MCP, or payment reconciliation yet. The SQL is deliberately
outside the Drizzle journal until the shared integration owner approves the migration.

## Semantics

- `tracked` stores non-negative integer `on_hand` and `reserved`; `available = on_hand - reserved`.
- `untracked` is an explicit seller decision, stores no quantity, and is not treated as zero. A
  product with no `inventory_stock` row has no decision and checkout must fail closed.
- The initial tracked/untracked decision is itself idempotent, reasoned and audited, and cannot be
  replayed under a different key to reset stock or switch modes. Later tracked quantity changes use
  versioned adjustments.
- Each cart quantity is a positive integer up to 1,000,000. A cart cannot repeat a product line; callers combine it.
- Services and their technician capacity stay in booking logic, outside inventory reservations.
- Manual adjustments require an authenticated seller principal, expected version, stable
  idempotency key and human-readable reason. The unique adjustment ledger and append-only audit
  row are committed with the on-hand change. A retry with a different payload conflicts.
- Reservation creates one idempotent record for the whole cart, locks product stock rows in UUID
  order and updates all tracked rows in one transaction. If any line is unknown or insufficient,
  none are reserved. Untracked rows are recorded in the reservation but have no quantity mutation.
- Commit records a PayPal capture the reconciliation layer has already verified as `COMPLETED`; it
  never creates or captures a provider order. Before calling it, reconciliation must also verify
  the capture belongs to the expected order and matches its stored recipient, amount and currency.
  It consumes reserved quantity exactly once, using a unique capture ID. A reservation that is
  expired or released must stop any future capture attempt. If a capture already happened despite
  that gate, commit moves it to `review_required`; it does not decrement on-hand or claim the order
  fulfilled. Any still-held quantity remains reserved until a person resolves payment and stock; a
  reservation released earlier cannot reclaim stock here.
- Release is allowed only after a caller has established `verified_unpaid`, `verified_cancelled`
  or `verified_expired_unpaid`. An ambiguous provider outcome keeps the reservation and continues
  reconciliation; it is not a reason to capture after expiry. `review_required` is for an already
  completed late capture. Committed or review reservations cannot release. Refunds do not restock
  automatically.
- Seller access is scoped by a server-derived `{shopId, actorId}` principal from the identity
  boundary. `shopId`/`actorId` are never accepted as authority from tool or HTTP input.

## Module API

`contracts/inventory.ts` is the input source of truth. `inventory/postgres.ts` provides:

- `readStock(pool, principal, productId)`
- `setInventoryMode(pool, principal, productId, decision)`
- `adjustInventory(pool, principal, input)`
- `reserveInventory(pool, shopId, key, lines, expiresAt)`
- `commitReservation(pool, shopId, reservationId, {captureId, providerStatus: 'COMPLETED', verified: true})`
- `releaseReservation(pool, shopId, reservationId, verifiedOutcome)`

Buyer reservation calls need a server-trusted shop resolved from the validated cart. They must not
accept a client-selected tenant. The reservation key should be derived from the order identity so
retrying order creation returns the same reservation. Booking deposit flows never call this API.

## Required shared integration

1. Catalog import must preserve a supplied quantity and require a seller decision if none was
   supplied; it cannot silently invent unlimited stock.
2. Checkout quote/create must atomically reserve before handing out a PayPal approval URL, with
   release only when PayPal's outcome is known to be unpaid. An unknown PayPal response must keep
   the reservation while reconciliation continues.
3. The verified capture/payment hook must commit reservation once. A capture after reservation
   expiry needs a review/refund-or-rebook path without stock oversell.
4. Seller HTTP and MCP tools must bind to identity's `requireSellerShopPrincipal` result.
5. The Drizzle schema and ordered migration journal need a single integration owner to incorporate
   `drizzle/inventory-module-draft.sql`; this module draft is not production migration-ready.
