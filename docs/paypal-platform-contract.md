# PayPal platform contract: sandbox authorization

This contract describes the implemented platform-app path and its current Sandbox evidence. The server keeps one platform REST app secret, each shop owner starts a Partner Referrals consent flow, and the verified seller merchant ID selects the payee for that shop. No PayPal credential or access token is given to a shop owner, buyer, or agent

## Verified Sandbox snapshot: 8 November 2026

The platform OAuth token, requested scopes and BN configuration were verified. One seller completed human consent and a provider-backed merchant-status refresh reported the connection ready. A buyer manually approved a EUR 1 MCP checkout; the app persisted the order for that onboarded payee, verified `APPROVED`, captured it, verified `PAYMENT.CAPTURE.COMPLETED`, and processed the corresponding verified receipts. Independent Orders GET returned 200/COMPLETED with one COMPLETED capture for EUR 1.00 and the expected seller payee. This is evidence for one seller and one Sandbox transaction, not a two-seller result. The fresh merchant-status check confirmed payments receivable, primary email, active EXPRESS_CHECKOUT and authcapture permission; the second seller remains blocked by a PayPal UserInfo HTTP 401, so restore that account's Sandbox Login consent or ask PayPal for account support; Catalog permissions and webhook redelivery deduplication remain unverified

## Implemented boundary

- `src/server/paypal/partner-referrals.ts` obtains a platform client-credentials token, creates a referral, reads merchant-integration status, and verifies consent-revocation webhooks
- `src/server/paypal/orders.ts` selects the platform app only for a persisted ready seller connection, adds a seller `PayPal-Auth-Assertion` and the platform BN code to Orders calls, and rejects an order whose `payee` differs from the selected seller
- `src/server/paypal/catalog.ts` sends product metadata with the platform token and seller assertion; AgentShelf remains the source for price, quantity, and reservations
- Adapters and local tests prove request construction and policy checks. The dated snapshot above records the separately observed Sandbox permissions, consent, capture and receipt processing; it does not establish Catalog permissions or webhook redelivery deduplication

## API and authorization map

Use the Sandbox host `https://api-m.sandbox.paypal.com`. OAuth client ID and secret are server-only platform-app credentials. A client-credentials token identifies the platform app; it is not seller consent. Partner calls use the assigned BN code, while on-behalf-of-seller calls also identify the selected merchant with `PayPal-Auth-Assertion`

| Operation | Implemented API path | Credential and permission boundary | Verified evidence / remaining checks |
| --- | --- | --- | --- |
| Platform OAuth | `POST /v1/oauth2/token` | Platform app client ID and secret via HTTP Basic, `grant_type=client_credentials`; inspect the returned scope set and `expires_in` | Verified for the configured Sandbox platform app; requested scopes and BN configuration were checked |
| Seller consent link | `POST /v2/customer/partner-referrals` | Platform bearer token, `PayPal-Partner-Attribution-Id`; app scope `https://uri.paypal.com/services/customer/partner-referrals/readwrite`. Current request asks for `API_INTEGRATION`, feature `PAYMENT`, product `EXPRESS_CHECKOUT`, and share-data consent | One seller completed human consent; a provider-backed merchant-status refresh reported ready. Second seller remains blocked by UserInfo HTTP 401 |
| Referral refresh | `GET {referral self URL}` | Same platform bearer and BN code; URL is stored server-side and constrained to PayPal Sandbox | Provider-backed refresh succeeded for the connected seller. Merchant status was verified separately |
| Seller status | `GET /v1/customer/partners/{platform_merchant_id}/merchant-integrations/{seller_merchant_id}` | Platform bearer and BN code; documented app scope `https://uri.paypal.com/services/customer/partner`. This is the deprecated v1 status API currently used by the adapter; callback values are hints only | The provider-backed status refresh verified merchant/tracking IDs, `payments_receivable`, primary email, active `EXPRESS_CHECKOUT`, and seller-granted `https://uri.paypal.com/services/payments/payment/authcapture` |
| Create order | `POST /v2/checkout/orders` | Platform bearer with app scope `https://uri.paypal.com/services/payments/payment`, seller assertion `{ iss: platform_client_id, payer_id: seller_merchant_id }`, BN code, and matching `purchase_units[].payee.merchant_id`; seller must grant payment access | One EUR 1 MCP checkout was created for the onboarded seller; local order payee matched the connected merchant |
| Read order | `GET /v2/checkout/orders/{id}` | Same platform bearer and seller assertion for the persisted order seller; keep order/shop authorization server-side | Independent GET returned 200/COMPLETED using the platform token, BN code and seller assertion; payee, EUR 1.00 amount and one COMPLETED capture match the connected seller and saved order |
| Capture order | `POST /v2/checkout/orders/{id}/capture` | Same platform bearer and seller assertion, idempotency key; buyer must first approve | One human-approved Sandbox checkout produced `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.COMPLETED` events; the capture receipt was verified and processed. PayPal's immediate-capture guide also lists partner approval |
| Create/read catalog product | `POST /v1/catalogs/products`, `GET /v1/catalogs/products/{id}` | Platform bearer and BN code; current adapter also sends seller assertion. PayPal labels `https://uri.paypal.com/services/subscriptions` as product-management scope; confirm app authorization rather than inferring it from seller `PAYMENT` consent | Verify against intended Sandbox context. Catalog records do not set price, stock, or reservations |
| Subscribe / verify webhook | `POST /v1/notifications/webhooks` (subscription management not implemented), `POST /v1/notifications/verify-webhook-signature` | Owning app's bearer; subscription management scope `https://uri.paypal.com/services/applications/webhooks`. Verification uses that subscription's ID, event, and PayPal transmission headers; it proves authenticity, not setup | Verified receipts for `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.COMPLETED` were processed. Two subscriptions were registered and read back; deduplication under actual webhook redelivery remains unverified |

PayPal's onboarding checklist requires Partner Referrals features to match the platform app configuration. Keep `PAYMENT` as the requested seller feature unless an approved, documented product change requires more. Do not request `PARTNER_FEE`, `REFUND`, or other features by implication

PayPal's Partner Referrals responses may use either the `api-m.sandbox.paypal.com` or `api.sandbox.paypal.com` host for the `self` link. Signup action samples use `www.sandbox.paypal.com/{locale}/merchantsignup/partner/onboardingentry?token=...` or `{api-m|api}.sandbox.paypal.com/bizsignup/partner/entry?referralToken=...`; the observed Sandbox response also used the `www.sandbox.paypal.com` host with that exact `bizsignup` path. The adapter accepts only these exact Sandbox host/path/query combinations, with `token` restricted to the onboarding path and `referralToken` restricted to the `bizsignup` path; it does not follow redirects or accept arbitrary provider links. See [the PayPal Partner Referrals integration sample](https://developer.paypal.com/platforms/checkout/apm/pay-upon-invoice/integrate-pui-partners)

## Approval and proof status

PayPal's onboarding and immediate-capture guides list partner approval as a requirement, while its [platform setup guide](https://developer.paypal.com/platforms/create-account/) says Sandbox APIs can be tested before approval. Treat approval as a production-readiness requirement, not a blocker to Sandbox API tests; the dated evidence above confirms this app's tested Sandbox access. The onboarding guide names `MERCHANT.ONBOARDING.COMPLETED` and `MERCHANT.PARTNER-CONSENT.REVOKED`

For capture, PayPal's [immediate-capture guide](https://developer.paypal.com/platforms/checkout/immediate-capture) requires seller onboarding, a platform access token, seller assertion, BN code, and buyer approval. The 8 November Sandbox capture met these gates for one connected seller; do not generalize it to other sellers or Live payments

AgentShelf verifies revocation and payment webhook signatures. The 8 November Sandbox receipts confirm processing for one approved order; app OAuth, scopes and BN configuration were independently checked. Catalog permissions and deduplication on webhook redelivery remain unverified. Public health checks are not PayPal evidence

Next, recover and separately verify the second seller's Login and consent; test Catalog permissions and webhook redelivery deduplication separately; keep all tests in Sandbox and record only sanitized response fields

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
