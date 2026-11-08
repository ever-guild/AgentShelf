# PayPal merchant connection module

This module provides the connection service, PostgreSQL repository (`0012_paypal_merchant_connections.sql`), fixed-Sandbox Partner Referrals adapter, Next.js route wrappers under `/api/seller/paypal/connection*`, owner UI at `/seller/paypal-connection`, checkout eligibility gate (`src/server/paypal/merchant-eligibility.ts`), and seller MCP integration (`connect_paypal_sandbox` / `get_paypal_connection_status`).

## Service contract

Implementation: [`src/server/paypal/merchant-connection.ts`](../src/server/paypal/merchant-connection.ts). The service principal matches the identity contract's `SellerShopPrincipal`, `{ actorId, shopId }`, after owner session or seller-agent grant resolution. An injected `authorizeShop` policy rechecks membership. The service also requires `principal.shopId === shopId` on `start`, `get`, and callback completion. Routes/MCP must derive this principal from membership or a grant with `connect_paypal`; a caller-provided shop ID never grants access.

```ts
const service = createMerchantConnectionService({
  repository, // atomic persistence contract below
  paypal, // fixed-Sandbox Partner Referrals adapter
  authorizeShop, // checks owner membership or explicit seller-agent grant
  returnUrl: "https://<configured-app-origin>/api/seller/paypal/connection/callback",
});

await service.start(principal, { shopId, idempotencyKey, shareDataConsent: true });
await service.complete(principal, { trackingId, sellerMerchantIdHint });
await service.get(principal, shopId);
await service.handleRevocationWebhook({ headers, rawBody });
```

The view states are `not_connected`, `pending`, `ready`, `revoked`, and `error`. Starting requires an explicit `shareDataConsent: true`; the service stores the authenticated owner ID and server timestamp in the reservation transaction before calling PayPal. Owner UI supplies this only after an explicit checkbox. Seller MCP must derive it from a verified owner-issued `connect_paypal` grant that recorded the same acknowledgment; never accept it from tool arguments. `actionUrl` is returned only to the consenting owner or the same authenticated principal on an idempotent replay. Status views never contain PayPal merchant IDs, referral URLs, platform credentials, access tokens, or raw provider responses.

## PayPal correlation and readiness

The flow uses the documented Partner Referrals `tracking_id` field. PayPal returns that value as `merchantId`; the callback's `merchantIdInPayPal` is only an untrusted seller ID hint. The service loads the original shop binding from the tracking ID and rechecks the authenticated principal's access to that shop. It then reads `GET /v1/customer/partners/{platform_merchant_id}/merchant-integrations/{seller_merchant_id}` using platform credentials.

A connection becomes `ready` only when PayPal's response echoes both the expected `tracking_id` and seller merchant ID, the third-party integration shows consent, `payments_receivable` and `primary_email_confirmed` are true, `EXPRESS_CHECKOUT` is active, and the configured `payment/authcapture` scope is granted. Account existence, callback query flags, or successful platform OAuth alone do not grant readiness. An incomplete response remains pending; provider errors remain safely retryable through a later status check.

Duplicate start requests are scoped to shop plus a hash of the request idempotency key. Repository `reserveStart` must be atomic and enforce unique tracking IDs. A repeated request with a stored referral resource refreshes its single-use action URL by GET. The Partner Referrals create operation's official API reference does not document `PayPal-Request-Id`; therefore the adapter does not invent that header or retry the mutating POST. A network timeout or unusable 2xx response is `pending` with an unknown outcome and cannot be automatically posted again. An unambiguously rejected request becomes `error` and may be started again with a new request key.

The adapter in [`src/server/paypal/partner-referrals.ts`](../src/server/paypal/partner-referrals.ts) fixes requests to Sandbox, uses server-side client-credentials OAuth, validates response links against the exact Sandbox API and onboarding hosts, and verifies consent-revocation webhooks through PayPal's Sandbox `verify-webhook-signature` endpoint using `PAYPAL_PLATFORM_WEBHOOK_ID`. Register that subscription at `/api/seller/paypal/connection/webhook`. Payment events use a separate subscription and ID, `PAYPAL_PLATFORM_PAYMENT_WEBHOOK_ID`, at `/api/paypal/platform-webhooks`; do not reuse one ID for both URLs. An injected verifier remains available for tests. A verified revocation event is deduplicated even if it arrives before a seller mapping is persisted; the stored tombstone prevents an in-flight status read from restoring stale `ready` state. No live host or credential option exists.

## Persistence contract for the owner

The module injects `MerchantConnectionRepository`, implemented by `PostgresMerchantConnectionRepository` in [`src/server/paypal/postgres-merchant-connection.ts`](../src/server/paypal/postgres-merchant-connection.ts) and backed by migration [`drizzle/0012_paypal_merchant_connections.sql`](../drizzle/0012_paypal_merchant_connections.sql). The repository provides:

- Atomic `reserveStart(shopId, consentedByOwnerId, shareDataConsentAt, requestKeyHash, trackingId)`, with a composite owner-membership foreign key, unique `(shop_id, request_key_hash)`, and unique `tracking_id` constraints. A pending referral blocks creation of another referral for that shop.
- Lookup by shop and tracking ID, both resolving to exactly one shop-bound record.
- Persist referral `self` URL and ID only after strict validation; do not persist or log `action_url`.
- Atomic status update that cannot overwrite `revoked` with a late callback/status response, downgrade `ready` after a late create timeout, or change an already-bound seller merchant ID. `saveReferral` and `markStartFailure` must also preserve a concurrently verified `ready` or `revoked` state.
- Atomic revocation update keyed by verified event ID and bound seller merchant ID; duplicate events are no-ops. Verified unmatched events are retained as nullable-connection tombstones and stop a stale in-flight status check from restoring readiness.
- Store only the status evidence required by the agreed owner/shop checkout contract. Do not store seller PayPal credentials or OAuth access tokens.

The checkout consumer (`resolveShopPayPalRoute` in [`src/server/paypal/merchant-eligibility.ts`](../src/server/paypal/merchant-eligibility.ts)) treats every state except a verified `ready` connection as unavailable (`PAYMENT_NOT_CONFIGURED`).

## Verification and current limits

Mock and isolated PostgreSQL tests cover shop authorization, explicit consent, callback shop binding, tracking mismatch, ambiguous POST replay prevention, repeated ready callback, status readiness gates, webhook verification/deduplication/tombstones, fixed hosts, and sanitized errors. Tests make no PayPal network requests. Full closure of [#35](https://github.com/ever-guild/AgentShelf/issues/35) requires human completion of the second independent seller's PayPal Sandbox consent flow so two distinct connected merchants are verified in Sandbox.

## Primary PayPal documentation

- [Platform setup and Sandbox testing before partner approval](https://developer.paypal.com/platforms/get-started)
- [Partner Referrals create operation and request schema](https://developer.paypal.com/api/partner-referrals/v2/partner-referrals-create)
- [Before-payment onboarding, callback parameters, status GET, and readiness fields](https://developer.paypal.com/platforms/seller-onboarding/before-payment/)
- [Feature settings must match between the REST app and Partner Referrals request](https://developer.paypal.com/platforms/seller-onboarding/onboarding-checklist/)
- [Platform auth assertion and attribution headers for later payment calls](https://developer.paypal.com/api/make-api-requests)
- [Consent revocation webhook event](https://developer.paypal.com/platforms/seller-onboarding/before-payment/)
