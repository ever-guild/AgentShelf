# PayPal sandbox proof runbook

Status on 6 November 2026: `BLOCKED`, neither seller has separate Sandbox app credentials and merchant ID configured, this proof has not obtained an OAuth token or created an order, and no buyer approval, capture or webhook registration has been verified

This runbook describes the controlled `paypal:proof` CLI in [`scripts/paypal-proof.ts`](../scripts/paypal-proof.ts) for [proof issue #2](https://github.com/ever-guild/AgentShelf/issues/2), it records a candidate procedure and does not claim a completed payment

## Capability status

| Capability | Current evidence |
| --- | --- |
| PayPal Server SDK | `@paypal/paypal-server-sdk` 2.5.0 is installed, methods checked against immutable [upstream commit `790be9be9b694be08157e1cd5d50321c72727a76`](https://github.com/paypal/PayPal-TypeScript-Server-SDK/tree/790be9be9b694be08157e1cd5d50321c72727a76) |
| Harness | `create`, `inspect` and human-gated `capture` commands exist, tests use synthetic credentials and mock responses only |
| Sandbox sellers | Proof readiness is per seller, each needs its own REST app, client ID, client secret and merchant ID, both are currently `BLOCKED` |
| OAuth and Orders calls | Not run, credentials are missing |
| Buyer approval and capture | Not run, no order exists |
| Catalog Products and webhooks | Not tested or registered |
| PayPal Agent Toolkit | Not a project dependency, no Toolkit runtime or tools are used |

## Accounts and authorization

The candidate flow uses a seller-owned Sandbox REST app and that seller's own merchant ID as `payee.merchantId`, with a separate Personal Sandbox buyer who manually approves each order

This self-payee approach is a hypothesis pending an actual sandbox result, it does not prove platform merchant permissions, seller consent, Partner Referrals enrollment or cross-merchant authorization

Live payments, production credentials, real seller onboarding and Partner Referrals are outside this proof's scope

PayPal distinguishes first-party requests from platform requests on behalf of another merchant, its [REST authorization guide](https://developer.paypal.com/api/make-api-requests) describes `PayPal-Auth-Assertion`, `PayPal-Partner-Attribution-Id` and merchant consent for third-party calls, stop on any permission error rather than adding platform headers

| Role | App and use | Status |
| --- | --- | --- |
| Demo Phone Workshop | Business Sandbox account and its own REST app, seller/payee for one EUR order | `BLOCKED`, credentials and merchant mapping absent |
| Second shop | Separate Business Sandbox account and its own REST app, seller/payee for a different order | `BLOCKED`, credentials and merchant mapping absent, seed support also pending |
| Buyer | Separate Personal Sandbox account, signs in and approves manually | Not configured in the CLI or server environment |

Use the current [PayPal Sandbox account setup](https://developer.paypal.com/sandbox-testing/accounts) and [REST API setup](https://developer.paypal.com/api/get-started/) instructions to create or confirm these roles

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

Repeat with a different UUID and reference such as `proof-2026-11-06-second-01` and `--shop DEMO_SECOND_SHOP`, each order is separate and must be approved by the buyer before its capture command

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

Verify public health checks separately as Render delivery evidence, HTTP health success does not establish OAuth, seller permission or a PayPal sandbox transaction

This runbook is separate from the [MCP `get_order_status` proposal for ppmarkek](paypal-order-status-contract.md), it does not implement or complete [issue #5](https://github.com/ever-guild/AgentShelf/issues/5), [issue #11](https://github.com/ever-guild/AgentShelf/issues/11) or [proof issue #2](https://github.com/ever-guild/AgentShelf/issues/2)
