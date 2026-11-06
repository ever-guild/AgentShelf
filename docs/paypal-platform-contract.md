# AgentShelf platform and seller PayPal contract

This is a target integration contract for sandbox seller onboarding. It does not change the existing checkout, order, webhook, or database services. The direct-merchant proof remains a separate diagnostic path and is not evidence that platform onboarding works.

## Ownership and lifecycle

- AgentShelf owns shop registration, catalog, prices, stock, and fulfillment state. A PayPal account is separate from an AgentShelf shop.
- AgentShelf owns one platform REST app and its credentials. Do not ask each seller to create a REST app, provide client secrets, or configure Render credentials.
- The seller owns their PayPal account and explicitly grants AgentShelf the features requested through a PayPal Partner Referrals consent flow. The seller can sign in to an existing account or create one. For PayPal Checkout, PayPal documents personal-account eligibility subject to account intent and country/product rules.
- Persist the AgentShelf shop ID, a unique referral tracking ID, referral state, PayPal merchant ID after callback, and verified integration status. Never store seller PayPal credentials. The action URL is single-use and should be treated as a short-lived secret; do not log it or expose it beyond the intended seller.

## Future server flow

1. An authenticated shop owner requests PayPal connection. The server creates one Partner Referrals request for that AgentShelf shop, using a stable tracking ID, configured return URL, and only the approved `products` and `features`. The server returns the resulting PayPal `action_url` to the owner's browser. Creating the referral is a mutating API operation and is intentionally absent from the preflight script.
2. PayPal handles login/account signup and explicit consent. The browser returns with tracking/merchant/permission query parameters. Treat them as untrusted input: resolve the shop from the server-stored tracking ID, validate the expected callback, and query PayPal's merchant-integration status before changing the shop to connected.
3. The status check must confirm `payments_receivable === true`, `primary_email_confirmed === true`, and the required granted permissions/scopes for the configured payment solution. If status is incomplete, show PayPal's documented next action and keep the shop disconnected. Revoke/disconnect events must disable checkout.
4. Existing Orders v2 code may be adapted separately to platform authentication: obtain an access token with the platform app, set `PayPal-Auth-Assertion` for the selected seller, set `PayPal-Partner-Attribution-Id` to the platform BN code, and set the order's `payee` to that same seller. Verify the selected shop/seller mapping server-side. Require buyer approval before capture. The platform assertion identifies the seller; it does not replace consent or status verification.
5. Configure onboarding and payment event subscriptions on the platform REST app, then verify webhook signatures and deduplicate event IDs. PayPal documents that webhooks are associated with the app that generated the events. Webhook setup and end-to-end delivery remain a separate verification requirement.

## Product and inventory boundary

PayPal Catalog Products creates product metadata (name, description, type, category, image and home URLs). Its documented create-product schema has no stock or reservation quantity. AgentShelf remains the source of truth for catalog inventory and available quantities; a PayPal catalog record does not replace local stock checks.

## Test gates

- Offline preflight passes without making a network call; direct-merchant diagnostics are clearly labeled as separate.
- Platform Sandbox OAuth works with the platform app and does not expose credentials or tokens.
- A sandbox seller completes a referral/consent round trip; the server verifies the exact shop-to-tracking-ID-to-merchant mapping and status response.
- An incomplete/revoked seller is blocked from checkout. An onboarded seller can be selected only for their shop's order, followed by buyer approval and payment verification in the separately owned checkout/reconciliation work.
- Webhook signature verification, deduplication, and status transitions are demonstrated independently.
- No Live credentials, Live host, real payment, capture without buyer approval, or seller credential collection is part of this scope.

## Official references

- [Platform getting started](https://developer.paypal.com/platforms/get-started)
- [Seller onboarding overview](https://developer.paypal.com/platforms/seller-onboarding)
- [Seller onboarding checklist](https://developer.paypal.com/platforms/seller-onboarding/onboarding-checklist/)
- [Partner Referrals signup and status flow](https://developer.paypal.com/platforms/seller-onboarding/before-payment/)
- [PayPal-Auth-Assertion and partner attribution headers](https://developer.paypal.com/api/make-api-requests)
- [Immediate capture requirements and seller assertion](https://developer.paypal.com/platforms/checkout/immediate-capture)
- [Webhook app association and verification](https://developer.paypal.com/api/rest/webhooks/)
- [Catalog Products create schema](https://developer.paypal.com/api/catalog-products/v1/products-create/)
