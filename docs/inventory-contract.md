# Quantitative inventory contract (#36)

The inventory module, owner-scoped stock interfaces, PostgreSQL migrations, and physical purchase
checkout/payment hooks are implemented in the runtime. The live one-unit sandbox settlement is
recorded in [issue #36](https://github.com/ever-guild/AgentShelf/issues/36); that evidence verifies
one purchase, while PostgreSQL tests cover concurrency and state transitions.

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
- `createReservedPhysicalOrder` writes the purchase order, immutable line snapshots and stock
  reservation in one PostgreSQL transaction on the same client. Retries reuse the stored order and
  reservation; a different fingerprint conflicts. It does not create a PayPal order.
- Physical checkout creates the reservation before asking PayPal for an approval order. The
  reconciliation path claims a live allocation immediately before a new capture request. An
  already-started or ambiguous attempt is reconciled by reading its existing provider order rather
  than issuing another capture.
- `settlePhysicalOrderCapture` accepts only verified `COMPLETED` capture evidence with provider
  capture ID and provider timestamp. Reconciliation also verifies the capture against the stored
  order. It consumes stock and marks the order paid in one transaction; a late capture marks both
  for review and keeps any still-held units reserved.
- `closePhysicalOrderAfterVerifiedUnpaid` releases a purchase hold only after a verified unpaid,
  cancelled, or expired-unpaid provider result, and updates the order in the same transaction.

## Seller stock API

- `GET /api/seller/inventory/{productId}` returns mode, on-hand, reserved, available, version and
  `updatedAt` for the authenticated selected shop.
- `PATCH /api/seller/inventory/{productId}` records an audited quantity delta with an expected
  version, idempotency key and reason.
- `PUT /api/seller/inventory/{productId}/policy` requires an explicit tracked quantity or untracked
  decision. The initial policy cannot be reset or changed by retrying under another key.
- Routes use the canonical owner-session/shop membership check and derive the tenant from the
  authenticated principal; the body cannot select a shop.
- The protected seller MCP exposes `seller_manage_stock`. Reads require `read_shop`; setting a
  policy or adjusting stock requires `manage_inventory`. The seller grant supplies the shop and
  actor identity; tool arguments do not.

## Migration and catalog policy

- Numbered migration `0013_inventory_stock_reservations.sql` creates inventory and reservation
  tables and adds the tenant-scoped order link. Migration `0015_legacy_and_demo_inventory.sql`
  records historical non-import products as untracked because their quantities were unknown; it
  does not assign them invented quantities. The demo seed gives only its fixed synthetic products
  explicit tracked quantities and does not overwrite existing stock on reseed.
- Imported products are not silently given an unlimited or untracked policy. A product without an
  inventory row cannot be reserved; its seller must explicitly set tracked stock or choose
  untracked through the policy endpoint or seller MCP before checkout. CSV/import quantity values
  are not currently wired into the inventory policy automatically, so sellers must review/set the
  inventory decision separately.
- `drizzle/inventory-module-draft.sql` is a historical standalone draft, not part of the migration
  journal or the production upgrade path. Runtime setup uses the numbered migrations.

## Completion evidence and remaining gate

The implementation is deployed and its PostgreSQL concurrency/payment-settlement regression checks
passed. A real sandbox physical purchase settled the single allocated unit exactly once; issue #36
contains the sanitized result and its limitations. This one-unit happy path does not resolve the
[purchase-path findings](https://github.com/ever-guild/AgentShelf/issues/36#issuecomment-6707694617):
stock-policy setup after publication, cancellation/sweep release, ambiguous capture retry,
legacy orders without allocations, and demo stock reset. These require fixes and targeted
regressions; #34 is an additional delivery gate. Catalog UI coordination remains pending.
