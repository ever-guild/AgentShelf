# PayPal platform contract: sandbox authorization

This contract describes the implemented platform-app path and the PayPal evidence still needed to use it. The server keeps one platform REST app secret, each shop owner starts a Partner Referrals consent flow, and the verified seller merchant ID selects the payee for that shop. No PayPal credential or access token is given to a shop owner, buyer, or agent

## Implemented boundary

- `src/server/paypal/partner-referrals.ts` obtains a platform client-credentials token, creates a referral, reads merchant-integration status, and verifies consent-revocation webhooks
- `src/server/paypal/orders.ts` selects the platform app only for a persisted ready seller connection, adds a seller `PayPal-Auth-Assertion` and the platform BN code to Orders calls, and rejects an order whose `payee` differs from the selected seller
- `src/server/paypal/catalog.ts` sends product metadata with the platform token and seller assertion; AgentShelf remains the source for price, quantity, and reservations
- These adapters and local tests prove request construction and policy checks only. They do not prove app permissions, token scopes, seller consent, a Sandbox capture, or actual webhook delivery

## API and authorization map

Use the Sandbox host `https://api-m.sandbox.paypal.com`. OAuth client ID and secret are server-only platform-app credentials. A client-credentials token identifies the platform app; it is not seller consent. Partner calls use the assigned BN code, while on-behalf-of-seller calls also identify the selected merchant with `PayPal-Auth-Assertion`

| Operation | Implemented API path | Credential and permission boundary | Evidence still required |
| --- | --- | --- | --- |
| Platform OAuth | `POST /v1/oauth2/token` | Platform app client ID and secret via HTTP Basic, `grant_type=client_credentials`; inspect the returned scope set and `expires_in` | Successful token response from the configured Sandbox platform app |
| Seller consent link | `POST /v2/customer/partner-referrals` | Platform bearer token, `PayPal-Partner-Attribution-Id`; app scope `https://uri.paypal.com/services/customer/partner-referrals/readwrite`. Current request asks for `API_INTEGRATION`, feature `PAYMENT`, product `EXPRESS_CHECKOUT`, and share-data consent | Each owner must complete PayPal consent. The request asks for access; it does not establish that PayPal granted it |
| Referral refresh | `GET {referral self URL}` | Same platform bearer and BN code; URL is stored server-side and constrained to PayPal Sandbox | Successful refresh after an expired or consumed action URL |
| Seller status | `GET /v1/customer/partners/{platform_merchant_id}/merchant-integrations/{seller_merchant_id}` | Platform bearer and BN code; documented app scope `https://uri.paypal.com/services/customer/partner`. This is the deprecated v1 status API currently used by the adapter; callback values are hints only | Verify returned merchant and tracking IDs, `payments_receivable`, confirmed primary email, active `EXPRESS_CHECKOUT`, and seller-granted `https://uri.paypal.com/services/payments/payment/authcapture`. These are readiness gates, not observed grants |
| Create order | `POST /v2/checkout/orders` | Platform bearer with app scope `https://uri.paypal.com/services/payments/payment`, seller assertion `{ iss: platform_client_id, payer_id: seller_merchant_id }`, BN code, and matching `purchase_units[].payee.merchant_id`; seller must grant payment access | Confirm platform Sandbox access and seller's actual grant before checkout; create follows seller onboarding |
| Read order | `GET /v2/checkout/orders/{id}` | Same platform bearer and seller assertion for the persisted order seller; keep order/shop authorization server-side | Verify payee, amount, currency, and status against the local order |
| Capture order | `POST /v2/checkout/orders/{id}/capture` | Same platform bearer and seller assertion, idempotency key; buyer must first approve | Require current seller readiness and verified buyer approval; prove the Sandbox completed capture. PayPal's immediate-capture guide also lists partner approval |
| Create/read catalog product | `POST /v1/catalogs/products`, `GET /v1/catalogs/products/{id}` | Platform bearer and BN code; current adapter also sends seller assertion. PayPal labels `https://uri.paypal.com/services/subscriptions` as product-management scope; confirm app authorization rather than inferring it from seller `PAYMENT` consent | Verify against intended Sandbox context. Catalog records do not set price, stock, or reservations |
| Subscribe / verify webhook | `POST /v1/notifications/webhooks` (not implemented), `POST /v1/notifications/verify-webhook-signature` | Owning app's bearer; subscription management scope `https://uri.paypal.com/services/applications/webhooks`. Verification uses that subscription's ID, event, and PayPal transmission headers; it proves authenticity, not setup | Register separate onboarding and payment subscriptions on the platform app and retain each ID. Verify real Sandbox delivery and deduplication; simulator events alone are not payment evidence |

PayPal's onboarding checklist requires Partner Referrals features to match the platform app configuration. Keep `PAYMENT` as the requested seller feature unless an approved, documented product change requires more. Do not request `PARTNER_FEE`, `REFUND`, or other features by implication

## Approval and proof status

PayPal's onboarding and immediate-capture guides list partner approval as a requirement, while its [platform setup guide](https://developer.paypal.com/platforms/create-account/) says Sandbox APIs can be tested before approval. Treat approval as a production-readiness requirement, not a blocker to Sandbox API tests; this app's actual Sandbox access still needs proof. The onboarding guide names `MERCHANT.ONBOARDING.COMPLETED` and `MERCHANT.PARTNER-CONSENT.REVOKED`

For capture, PayPal's [immediate-capture guide](https://developer.paypal.com/platforms/checkout/immediate-capture) requires seller onboarding, a platform access token, seller assertion, BN code, and buyer approval. Keep immediate capture blocked until the buyer has approved and the app and seller permissions are verified

AgentShelf currently handles revocation verification and payment webhook verification, but subscription setup and actual Sandbox delivery remain to be verified. App permissions, returned token scopes, seller consent, capture, and webhook delivery are not confirmed by code or public health checks

The next proof is one owner-authorized Sandbox connection followed by merchant-status evidence, then a buyer-approved order and capture for that same seller, followed by verified webhook delivery. Keep the test in Sandbox and record only sanitized response fields

## Official references

- [Partner Referrals create](https://developer.paypal.com/api/partner-referrals/v2/partner-referrals-create/)
- [Seller onboarding before payment](https://developer.paypal.com/platforms/seller-onboarding/before-payment/)
- [Seller onboarding feature checklist](https://developer.paypal.com/platforms/seller-onboarding/onboarding-checklist/)
- [Show seller status API (deprecated v1)](https://developer.paypal.com/api/deprecated/partner-referrals/v1/merchant-integration-status)
- [Making REST API requests and partner headers](https://developer.paypal.com/api/make-api-requests)
- [Orders create](https://developer.paypal.com/api/orders/v2/orders-create/), [Orders read](https://developer.paypal.com/api/orders/v2/orders-get/), and [Orders capture](https://developer.paypal.com/api/orders/v2/orders-capture/)
- [Immediate capture requirements](https://developer.paypal.com/platforms/checkout/immediate-capture)
- [Catalog Products create](https://developer.paypal.com/api/catalog-products/v1/products-create/)
- [Webhook setup and signature verification](https://developer.paypal.com/api/rest/webhooks/rest/)
