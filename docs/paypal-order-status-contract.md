# Order status contract proposal for [MCP issue #5](https://github.com/ever-guild/AgentShelf/issues/5)

Status: implemented as proposed, in [`order-status.ts`](../src/server/services/order-status.ts) and the `get_order_status` tool in [`server.ts`](../src/server/mcp/server.ts), under [payment reconciliation issue #11](https://github.com/ever-guild/AgentShelf/issues/11). The text below is the original proposal and describes the code as it was at the snapshot

Snapshot: 6 November 2026, public repository commit [`50d5ef09f700417ec9e17e5ff80f2c90343c72e3`](https://github.com/ever-guild/AgentShelf/commit/50d5ef09f700417ec9e17e5ff80f2c90343c72e3)

This document defines a proposed service and MCP boundary, it does not claim that `get_order_status` is implemented or registered

## Current state

| Area | Verified in the snapshot |
| --- | --- |
| Input and result schemas | [`getOrderStatusInput` and `getOrderStatusResult`](../src/server/contracts/commerce.ts) already define camelCase fields `orderId`, `statusToken`, `paymentStatus`, `totalMinor`, `currency`, nullable `booking` and `updatedAt` |
| Capability | [`issueOrderStatusToken` and `verifyOrderStatusToken`](../src/server/auth/order-status-token.ts) derive an HMAC for purpose `order-status:v1` and the order ID, the token is not stored |
| Capability tests | [`order-status-token.test.ts`](../src/server/auth/order-status-token.test.ts) covers correct order, stable derivation, cross-order rejection, tampering, purpose separation and secret rotation |
| Persisted payment state | [`schema.ts`](../src/server/db/schema.ts) defines `pending`, `approved`, `paid`, `cancelled`, `failed` and `review_required`, and requires a capture ID before persisting `paid` |
| Errors | [`ServiceError`](../src/server/errors.ts) has safe JSON serialization and a fixed code-to-HTTP mapping, but no order-status-specific code yet |
| MCP registration | [`server.ts`](../src/server/mcp/server.ts) currently registers `search_products` and `create_checkout`, it does not register `get_order_status` |
| Status service | No order-status read service exists in this snapshot, and [`createCheckout`](../src/server/services/checkout.ts) currently returns `PAYMENT_UNAVAILABLE` after validating the quote |
| Public MCP note | [`docs/mcp.md`](mcp.md) says `get_order_status` is not offered yet and assigns it to [issue #11](https://github.com/ever-guild/AgentShelf/issues/11) |

The schema and capability are groundwork only, they are not an available endpoint or evidence that an order can currently be created

## Proposed tool contract

Use the existing strict input names and result schema unless the owners agree to a documented change

```json
{
  "orderId": "30000000-0000-4000-8000-000000000001",
  "statusToken": "test-only-capability-token-created-by-test"
}
```

`orderId` is the stored AgentShelf UUID, `statusToken` is the opaque bearer capability returned with the order creation result, do not accept a shop ID, buyer identity, PayPal order ID or requested status from the caller

The current result schema is the proposed minimal public result for compatibility with the existing contract

```json
{
  "orderId": "30000000-0000-4000-8000-000000000001",
  "paymentStatus": "pending",
  "totalMinor": 990,
  "currency": "EUR",
  "booking": null,
  "updatedAt": "2026-11-06T12:00:00Z"
}
```

For a booking order, return only the booking state already described by `getOrderStatusResult`: booking ID, booking status, scheduled start and end, expiry and IANA timezone

Do not add line items, buyer or payer details, shop or merchant IDs, credentials, raw PayPal responses, webhook payloads, approval URLs or capture IDs to this response

## Status semantics

The public field is named `paymentStatus` and follows the existing database enum, the requested short label `review` therefore maps to the persisted and returned value `review_required`

| Public `paymentStatus` | Proposed meaning |
| --- | --- |
| `pending` | Order is stored but approval or a conclusive payment outcome has not been recorded |
| `approved` | Buyer approval is verified, capture has not been verified, this is not paid |
| `paid` | A successful capture is verified and persisted with its capture ID |
| `cancelled` | The order has a verified cancellation outcome |
| `failed` | A definitive payment failure is persisted and there is no unresolved capture result |
| `review_required` | Provider state is unknown, contradictory or otherwise needs reconciliation, do not imply success or initiate another charge |

Issue [#11](https://github.com/ever-guild/AgentShelf/issues/11) owns mapping authoritative PayPal responses and verified webhooks into these persisted states, an unknown capture outcome must remain `review_required` until reconciliation resolves it

## Capability and read behavior

Treat `statusToken` as a bearer capability, whoever holds both the exact `orderId` and matching token can read that order status, it is not a user login or proof of identity

The existing signer derives a stable HMAC using `APP_SIGNING_SECRET`, the token is bound to one order ID, the purpose string separates it from seller-session tokens, and rotating the secret invalidates existing tokens

Before any database lookup, validate the strict input and verify the capability for the supplied order ID, then select only that order and its associated booking

This operation reads the locally persisted reconciliation snapshot only, it must not create an order, call capture, approve or cancel an order, change payment or booking state, trigger fulfillment, or query a PayPal endpoint as a hidden mutation path

Issue [#11](https://github.com/ever-guild/AgentShelf/issues/11) owns reconciliation writes and their concurrency rules, the status read must reflect persisted state and leave reconciliation to those write paths

For a missing order and an invalid or mismatched capability, return the same generic `ORDER_STATUS_UNAVAILABLE` error with HTTP 404 and no details, this proposed code is not in the current `ServiceError` union

Keep malformed input as `INVALID_INPUT`, preserve `SERVER_MISCONFIGURED` for signing configuration failures, and do not echo rejected token or order values in error details

## Service boundary between [#11](https://github.com/ever-guild/AgentShelf/issues/11) and [#5](https://github.com/ever-guild/AgentShelf/issues/5)

Issue [#11](https://github.com/ever-guild/AgentShelf/issues/11) should own the domain read service, capability verification, database lookup, persisted-state semantics and status tests

Proposed module and signature, neither exists in this snapshot

```ts
export async function getOrderStatus(
  db: Db,
  rawInput: unknown,
): Promise<z.infer<typeof getOrderStatusResult>>
```

The service parses `rawInput` with `getOrderStatusInput`, verifies `statusToken` against `orderId`, reads the persisted order and optional booking, and returns only `getOrderStatusResult`

Issue [#5](https://github.com/ever-guild/AgentShelf/issues/5) should own only the MCP tool registration and transport-level coverage, it should use the shared schemas and delegate to the service rather than querying tables or translating provider state inside the MCP handler

Proposed registration follows the existing `server.ts` pattern

```ts
server.registerTool(
  "get_order_status",
  {
    title: "Get order status",
    description: "Read the status of one order using its order ID and status token",
    inputSchema: getOrderStatusInput,
    outputSchema: getOrderStatusResult,
    annotations: {
      title: "Get order status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  (input) => toolResult(() => getOrderStatus(db, input)),
);
```

Issue [#6](https://github.com/ever-guild/AgentShelf/issues/6) must return the capability from product checkout creation and [issue #12](https://github.com/ever-guild/AgentShelf/issues/12) must return it from booking creation, neither issue should duplicate the status lookup or payment-state mapping

## Acceptance fixtures

Use synthetic UUIDs and a test-only `APP_SIGNING_SECRET`, mint test capabilities with `issueOrderStatusToken`, and never copy a production token into fixtures

| Fixture | Expected result |
| --- | --- |
| Matching order ID and valid capability, persisted `pending` | Exact result shape with `paymentStatus: "pending"` |
| Matching capability, verified approval without a capture ID | `approved`, never `paid` |
| Matching capability, verified capture ID and persisted successful capture | `paid` and the stored integer amount and currency |
| Matching capability, definitive cancellation or failure | `cancelled` or `failed` respectively |
| Matching capability, unknown or contradictory capture outcome | `review_required`, with no capture attempt from the read call |
| Order A ID with Order B capability, altered token, valid-shaped random token or nonexistent ID | Same generic `ORDER_STATUS_UNAVAILABLE`, no order fields in error details |
| Valid order result containing injected payer email, merchant ID, credentials or raw provider fields | Strict output schema rejects the extra fields |
| Booking attached to the authorized order | Only that booking's status and schedule fields are returned |
| Every successful and failing read case | Database state unchanged and PayPal client or capture adapter call count remains zero |

Add service tests under [issue #11](https://github.com/ever-guild/AgentShelf/issues/11) and MCP registration/error-shape tests under [issue #5](https://github.com/ever-guild/AgentShelf/issues/5), keep the existing schema and token unit tests as prerequisite coverage

## Open decisions

- Confirm whether the buyer needs `booking.expiresAt` after the initial version, it is already part of the existing result schema but may not be required for a minimal response
- Confirm with issue owners that `ORDER_STATUS_UNAVAILABLE` should conceal both missing orders and invalid capabilities using the same 404 response
- Decide whether capability expiry is required before using status tokens outside the demo flow, the current deterministic token has no expiry and changing that property would need a new token design
- Confirm provider event and response mapping in [issue #11](https://github.com/ever-guild/AgentShelf/issues/11) against the exact PayPal integration version before pinning PayPal-specific source statuses

This proposal is a handoff for proof work tracked by [issue #2](https://github.com/ever-guild/AgentShelf/issues/2), it does not close or complete [issue #5](https://github.com/ever-guild/AgentShelf/issues/5) or [issue #11](https://github.com/ever-guild/AgentShelf/issues/11)
