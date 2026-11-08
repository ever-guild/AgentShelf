# PayPal sandbox proof runbook

Status on 8 November 2026: one seller completed platform-app consent and a buyer-approved EUR 1 MCP checkout was captured in Sandbox; the `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.COMPLETED` events were received, and the matching database capture and verified receipts were processed. This is one-seller evidence only; the second seller remains blocked by PayPal UserInfo HTTP 401, and Catalog permissions and webhook redelivery deduplication are unverified

This page retains the controlled `paypal:proof` CLI in [`scripts/paypal-proof.ts`](../scripts/paypal-proof.ts) as a historical direct-merchant diagnostic procedure from 6 November. It is not the current platform checkout path or evidence for the transaction above. See the [platform authorization contract](paypal-platform-contract.md) and [proof issue #2](https://github.com/ever-guild/AgentShelf/issues/2)

## Capability status

| Capability | Current evidence |
| --- | --- |
| PayPal Server SDK | `@paypal/paypal-server-sdk` 2.5.0 is installed, methods checked against immutable [upstream commit `790be9be9b694be08157e1cd5d50321c72727a76`](https://github.com/paypal/PayPal-TypeScript-Server-SDK/tree/790be9be9b694be08157e1cd5d50321c72727a76) |
| Harness | `create`, `inspect` and human-gated `capture` commands exist, tests use synthetic credentials and mock responses only |
| Platform seller connection | One seller completed human consent and a provider-backed merchant-status refresh reported ready; merchant-status readiness was verified. The second seller remains blocked by UserInfo HTTP 401 |
| Platform OAuth and checkout | Platform OAuth/scopes/BN were verified; one EUR 1 MCP order was created for the connected payee |
| Buyer approval and capture | Buyer manually approved; approval and completed-capture events received, matching database capture and verified receipts processed |
| Catalog Products and webhook retries | Catalog permissions unverified; receipts for this order were verified and processed, subscription redelivery deduplication remains unverified |
| PayPal Agent Toolkit | Not a project dependency, no Toolkit runtime or tools are used |

## Accounts and authorization

The verified transaction used the platform app and the merchant connected through owner consent as the order payee; a human buyer approved it in PayPal Sandbox. The payment receipt proves this one seller path, not a second seller or every platform permission

The direct-merchant CLI below uses a seller-owned REST app and is retained only as a historical diagnostic. It is not the target self-service onboarding path. Live payments and production credentials remain outside scope; Sandbox Partner Referrals are in scope

PayPal distinguishes first-party requests from platform requests on behalf of another merchant, its [REST authorization guide](https://developer.paypal.com/api/make-api-requests) describes `PayPal-Auth-Assertion`, `PayPal-Partner-Attribution-Id` and merchant consent for third-party calls, stop on any permission error rather than adding platform headers

| Role | App and use | Status |
| --- | --- | --- |
| Connected seller | Platform app, human-approved Partner Referrals consent, verified as payee for one EUR 1 order | One Sandbox checkout captured; merchant-status readiness was verified |
| Second seller | Separate Sandbox Business account, requires its own successful Login and consent flow | `BLOCKED`, PayPal UserInfo HTTP 401; restore account consent or contact PayPal support |
| Buyer | Separate Personal Sandbox account | Human approval completed for the verified checkout |

Use the current [PayPal Sandbox account setup](https://developer.paypal.com/sandbox-testing/accounts) and [REST API setup](https://developer.paypal.com/api/get-started/) instructions when resolving the blocked second seller; do not create duplicate accounts unless needed

## SDK and API boundary

The CLI constructs `Client` with `Environment.Sandbox` and `clientCredentialsAuthCredentials`, then constructs `OrdersController`

| CLI command | SDK method and API route | Gate |
| --- | --- | --- |
| `create` | `createOrder`, `POST /v2/checkout/orders` | One `CAPTURE` purchase unit, EUR amount, one seller `payee`, matching proof `referenceId` and `customId`, `PayPal-Request-Id` |
| `inspect` | `getOrder`, `GET /v2/checkout/orders/{id}` | Read only, checks the saved order against its seller, reference, amount and currency |
| `capture` | `getOrder`, `captureOrder`, `getOrder` again, `POST /v2/checkout/orders/{id}/capture` | Requires `--confirm-human-approved`, independently requires `APPROVED`, then accepts only `COMPLETED` with exactly one matching capture |

The SDK version, request fields and method signatures were checked source-first against the pinned [TypeScript Server SDK commit](https://github.com/paypal/PayPal-TypeScript-Server-SDK/tree/790be9be9b694be08157e1cd5d50321c72727a76), see the official [Create order](https://developer.paypal.com/api/orders/v2/orders-create), [Show order details](https://developer.paypal.com/api/orders/v2/orders-get) and [Capture payment](https://developer.paypal.com/api/orders/v2/orders-capture) references

The request uses `payment_source.paypal.experience_context`, the script accepts only an `approve` or `payer-action` link on PayPal's Sandbox checkout host, checks that its token matches the saved order ID and validates the returned payee and amount before proceeding

The CLI uses a 12 second timeout, disables SDK retries, retry-on-timeout and redirects, and suppresses raw SDK errors and response bodies, successful output still contains order/capture IDs and a buyer approval URL, keep it private and redact identifiers and URLs before sharing

## Configure and run

Set `APP_ORIGIN=https://agentshelf-e5bk.onrender.com` and these values in the existing local `.env.local`, which is Git-ignored, preserve an existing file and never place secret values in source, chat, screenshots, issues or the repository

| Shop selector | Client ID and secret | Seller merchant ID |
| --- | --- | --- |
| `DEMO_PHONE_WORKSHOP` | `PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP`, `PAYPAL_CLIENT_SECRET_DEMO_PHONE_WORKSHOP` | `DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID` |
| `DEMO_SECOND_SHOP` | `PAYPAL_CLIENT_ID_DEMO_SECOND_SHOP`, `PAYPAL_CLIENT_SECRET_DEMO_SECOND_SHOP` | `DEMO_SECOND_SHOP_PAYPAL_MERCHANT_ID` |

Run this proof only for a seller whose own app credentials and merchant mapping are ready and checked locally, with `APP_ORIGIN` set to the HTTPS origin, the other seller may remain blocked, the buyer's credentials are entered only on the PayPal Sandbox page

Create one unique reference and a fresh UUID v4 per seller order, preserve the UUID and reuse the exact reference, seller, amount, currency and payload for any permitted create retry

```sh
proof_ref=proof-2026-11-06-phone-01
create_request_id="$(node -p 'require("node:crypto").randomUUID()')"
printf 'Reference: %s\nCreate request UUID: %s\n' "$proof_ref" "$create_request_id"
npm run paypal:proof -- create \
  --shop DEMO_PHONE_WORKSHOP \
  --amount 1.00 \
  --currency EUR \
  --reference "$proof_ref" \
  --request-id "$create_request_id"
```

Open the printed Sandbox approval URL in a private browser session, sign in as the separate Personal buyer and approve manually, then inspect the saved reference

```sh
npm run paypal:proof -- inspect --reference "$proof_ref"
```

Only proceed if inspection reports `APPROVED` for the saved seller, reference, amount and currency, no other result authorizes capture

```sh
capture_request_id="$(node -p 'require("node:crypto").randomUUID()')"
printf 'Capture request UUID: %s\n' "$capture_request_id"
npm run paypal:proof -- capture \
  --reference "$proof_ref" \
  --request-id "$capture_request_id" \
  --confirm-human-approved
```

The commands above are retained only for the historical direct-merchant diagnostic. Do not use them as the current platform proof or create a duplicate order for the completed transaction

## Retry and evidence rules

The private journal is `.local/paypal-proof/proof-state.json`, its directory uses mode `0700`, the file uses `0600`, and the path is Git-ignored, it stores shop reference, merchant ID, amount, request UUIDs, order/capture IDs, HTTP codes and create payload, but not app secrets, access tokens, raw PayPal errors or approval URL

If a shell session is lost, recover UUIDs by reference from the journal rather than generating replacements

```sh
create_request_id="$(node -e 'const s=require("./.local/paypal-proof/proof-state.json");const r=s.records.find(x=>x.reference===process.argv[1]);if(!r)process.exit(2);process.stdout.write(r.createRequestId)' "$proof_ref")"
capture_request_id="$(node -e 'const s=require("./.local/paypal-proof/proof-state.json");const r=s.records.find(x=>x.reference===process.argv[1]);if(!r||!r.captureRequestId)process.exit(2);process.stdout.write(r.captureRequestId)' "$proof_ref")"
```

The harness allows replay of one unresolved create request with its identical request UUID for six hours, after that it refuses replay of that request, it does not block a new reference, but an operator must not create a replacement order while the original outcome is unknown, capture retries also require the original saved UUID

A timed-out write may have reached PayPal, inspect and reconcile the saved order before retrying, if the outcome remains uncertain stop and escalate to the owner

## Other PayPal capabilities

| Capability | Boundary and evidence |
| --- | --- |
| Catalog Products | Separate `POST /v1/catalogs/products`; PayPal documents `Create and manage products` scope for the [create operation](https://developer.paypal.com/api/catalog-products/v1/products-create/), this proof does not test that scope, app permissions or product creation |
| Webhooks | PayPal says webhook URLs are subscribed under each applicable REST app's settings or through the Webhooks Management API, and each registration has a Webhook ID for verification ([webhook setup](https://developer.paypal.com/api/rest/webhooks/rest/)); no app was registered, [issue #11](https://github.com/ever-guild/AgentShelf/issues/11) owns signature verification, reconciliation and actual registration |
| Agent Toolkit | `@paypal/agent-toolkit` is absent from [`package.json`](../package.json), this proof uses only the Server SDK and does not establish Toolkit integration ([official repository](https://github.com/paypal/agent-toolkit)) |
| APIMatic Context Plugin | Project-level instructions only, no runtime code; skills were applied to verify SDK configuration, constructed controller methods, request models, timeout/retry setup, error redaction and the Axios adapter unit-test seam |

The SDK facts were reviewed with `paypal-best-practices` and the APIMatic `typescript-getting-started`, `typescript-client-initialization`, `typescript-authentication`, `typescript-calling-endpoints`, `typescript-models`, `typescript-configuration-resilience`, `typescript-error-handling` and `typescript-testing` skills, [`src/server/paypal-proof.test.ts`](../src/server/paypal-proof.test.ts) uses synthetic values and mocks so tests do not prove real OAuth, merchant permission or a real order

For a PayPal proof report, keep sanitized role, transaction result and HTTP codes, redact merchant, order and capture IDs, credentials and approval URLs, attach the tested commit and proof artifacts

Verify public health checks separately as Render delivery evidence; HTTP health success does not establish OAuth, seller permission or a PayPal Sandbox transaction

This runbook is separate from the [MCP `get_order_status` proposal for ppmarkek](paypal-order-status-contract.md), it does not implement or complete [issue #5](https://github.com/ever-guild/AgentShelf/issues/5), [issue #11](https://github.com/ever-guild/AgentShelf/issues/11) or [proof issue #2](https://github.com/ever-guild/AgentShelf/issues/2)
