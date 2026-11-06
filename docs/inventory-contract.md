# Quantitative inventory contract (#36)

This documents the inventory domain module and standalone migration draft. Checkout and payment
reconciliation still need shared integration approval before they call these adapters. The SQL
remains outside the Drizzle migration journal until the migration owner incorporates it.

## Semantics

- `tracked` stores non-negative integer `on_hand` and `reserved`; `available = on_hand - reserved`.
- `untracked` is an explicit seller decision, stores no quantity, and is not treated as zero. A
  product with no `inventory_stock` row has no decision and checkout must fail closed.
- The initial tracked/untracked decision is idempotent, reasoned and audited. It cannot be replayed
  under a different key to reset stock or switch modes. Later tracked quantity changes use
  versioned adjustments.
- Each cart quantity is a positive integer up to 1,000,000. A cart cannot repeat a product line;
  callers combine it. Services and technician capacity stay in booking logic.
- Manual adjustments require an authenticated seller principal, expected version, stable
  idempotency key and human-readable reason. The unique adjustment ledger and append-only audit
  row are committed with the on-hand change. A retry with a different payload conflicts.
- Reservation locks product stock rows in UUID order and updates the entire cart in one transaction.
  If any line is undecided or insufficient, none are reserved. Untracked rows are recorded but do
  not mutate a quantity.
- `beginInventoryCapture` atomically changes a live `reserved` allocation to `capture_pending`.
  Only the winning caller may send a new provider capture request. Retries and reconciliation must
  read the existing provider result instead of sending another capture, including after expiry.
  Expiry prevents a new capture but does not discard stock held for an already-started capture.
- Commit records a PayPal capture the reconciliation layer has verified as `COMPLETED`, its
  provider-issued capture ID, and the provider's capture timestamp. It never creates or captures a
  provider order. Reconciliation must also verify that the capture belongs to the expected order
  and matches stored recipient, amount and currency. Webhook arrival time or a caller-supplied clock
  is not capture evidence. Reserved quantity is consumed exactly once only when the provider
  timestamp precedes reservation expiry. A completed capture after expiry or release moves the
  reservation to `review_required`; it does not decrement on-hand or claim the order fulfilled.
  Still-held quantity remains reserved until a person resolves payment and stock. A released
  reservation cannot reclaim stock here.
- Release is allowed only after a caller establishes `verified_unpaid`, `verified_cancelled` or
  `verified_expired_unpaid`. An ambiguous provider outcome keeps the reservation and continues
  reconciliation; it is not a reason to capture after expiry. Committed or review reservations
  cannot release. Refunds do not restock automatically.
- Seller access is scoped by a server-derived `{shopId, actorId}` principal from the identity
  boundary. `shopId`/`actorId` are never accepted as authority from tool or HTTP input.

## Required shared integration

1. Catalog import must preserve a supplied quantity and require a seller decision if none was
   supplied; it cannot silently invent unlimited stock.
2. Checkout quote/create must call `createReservedPhysicalOrder` before issuing an approval link,
   then claim `beginInventoryCapture` immediately before any new capture call. Unknown provider
   outcomes keep the reservation while reconciliation reads the existing provider result.
3. The verified capture/payment hook must pass provider-verified capture identity and timestamp to
   the inventory commit adapter. Late completed captures need a review/refund-or-rebook path without
   stock oversell.
4. Seller routes and MCP tools must bind to an identity-derived principal. The Drizzle schema and
   ordered migration journal need the migration owner's integration of
   `drizzle/inventory-module-draft.sql`; this standalone draft is not production migration-ready.
