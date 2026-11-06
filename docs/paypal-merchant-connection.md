# PayPal merchant connection module

This module now includes the connection service, PostgreSQL repository, fixed-Sandbox adapter, and framework-neutral HTTP handlers. The app route wrappers, migration journal, checkout gate, and seller MCP integration remain separate. Completion remains gated by [platform credential/permission proof #2](https://github.com/ever-guild/AgentShelf/issues/2), [Sandbox account setup #33](https://github.com/ever-guild/AgentShelf/issues/33), and the owner identity/membership work in [#34](https://github.com/ever-guild/AgentShelf/issues/34).

## Service contract

Implementation: [`src/server/paypal/merchant-connection.ts`](../src/server/paypal/merchant-connection.ts). The service principal matches the identity contract's `SellerShopPrincipal`, `{ actorId, shopId }`, after owner session or seller-agent grant resolution. An injected `authorizeShop` policy rechecks membership. The service also requires `principal.shopId === shopId` on `start`, `get`, and callback completion. Routes/MCP must derive this principal from membership or a grant with `connect_paypal`; a caller-provided shop ID never grants access.

```ts
const service = createMerchantConnectionService({
  repository, // atomic persistence contract below
  paypal, // fixed-Sandbox Partner Referrals adapter
  authorizeShop, // checks owner membership or explicit seller-agent grant
  returnUrl: "https://<configured-app-origin>/seller/paypal/callback",
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

The adapter in [`src/server/paypal/partner-referrals.ts`](../src/server/paypal/partner-referrals.ts) fixes requests to Sandbox, uses server-side client-credentials OAuth, validates response links against the exact Sandbox API and onboarding hosts, and verifies consent-revocation webhooks through PayPal's Sandbox `verify-webhook-signature` endpoint using `PAYPAL_PLATFORM_WEBHOOK_ID`. An injected verifier remains available for tests. A verified event is deduplicated even if it arrives before a seller mapping is persisted; the stored tombstone prevents an in-flight status read from restoring stale `ready` state. No live host or credential option exists.

## Persistence contract for the owner

The module injects `MerchantConnectionRepository`; its database implementation and migration remain separate from the shared shop schema in this worktree. The repository must provide:

- Atomic `reserveStart(shopId, consentedByOwnerId, shareDataConsentAt, requestKeyHash, trackingId)`, with a composite owner-membership foreign key, unique `(shop_id, request_key_hash)`, and unique `tracking_id` constraints. A pending referral blocks creation of another referral for that shop.
- Lookup by shop and tracking ID, both resolving to exactly one shop-bound record.
- Persist referral `self` URL and ID only after strict validation; do not persist or log `action_url`.
- Atomic status update that cannot overwrite `revoked` with a late callback/status response, downgrade `ready` after a late create timeout, or change an already-bound seller merchant ID. `saveReferral` and `markStartFailure` must also preserve a concurrently verified `ready` or `revoked` state.
- Atomic revocation update keyed by verified event ID and bound seller merchant ID; duplicate events are no-ops. Verified unmatched events are retained as nullable-connection tombstones and stop a stale in-flight status check from restoring readiness.
- Store only the status evidence required by the agreed owner/shop checkout contract. Do not store seller PayPal credentials or OAuth access tokens.

The checkout consumer must treat every state except `ready` as unavailable. The future route/MCP integration belongs to #34 and [seller agent #37](https://github.com/ever-guild/AgentShelf/issues/37); the separately owned payment provider/reconciliation remains under #2 and #6/#11. Inventory and catalog work in [#36](https://github.com/ever-guild/AgentShelf/issues/36) stays shop-owned and does not establish PayPal consent.

## Verification and current limits

Mock and isolated PostgreSQL tests cover shop authorization, explicit consent, callback shop binding, tracking mismatch, ambiguous POST replay prevention, repeated ready callback, status readiness gates, webhook verification/deduplication/tombstones, fixed hosts, and sanitized errors. Tests make no PayPal network requests. The repository and framework-neutral handlers are not yet wired to the migration journal or app routes; there is no real Sandbox consent evidence, checkout handoff, or configured webhook ID. Do not mark #35 complete until real sandbox consent and exact seller status evidence are recorded after #2/#34 are ready.

## Primary PayPal documentation

- [Platform setup and Sandbox testing before partner approval](https://developer.paypal.com/platforms/get-started)
- [Partner Referrals create operation and request schema](https://developer.paypal.com/api/partner-referrals/v2/partner-referrals-create)
- [Before-payment onboarding, callback parameters, status GET, and readiness fields](https://developer.paypal.com/platforms/seller-onboarding/before-payment/)
- [Feature settings must match between the REST app and Partner Referrals request](https://developer.paypal.com/platforms/seller-onboarding/onboarding-checklist/)
- [Platform auth assertion and attribution headers for later payment calls](https://developer.paypal.com/api/make-api-requests)
- [Consent revocation webhook event](https://developer.paypal.com/platforms/seller-onboarding/before-payment/)
