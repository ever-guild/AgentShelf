# PayPal sandbox setup

This guide prepares credentials for the current demo configuration; the application creates and captures Orders once a shop has these credentials and a merchant ID; the preflight only checks configuration and, with `--online`, sandbox OAuth credentials

## Accounts and apps

Reuse the existing sandbox accounts if they already match these roles, otherwise create them in PayPal Developer Dashboard under Testing Tools → Sandbox Accounts; PayPal provides a default Personal buyer and Business seller, and allows additional sandbox accounts

| Role | Account type | Purpose |
| --- | --- | --- |
| Demo Phone Workshop | Business | Seller account for `DEMO_PHONE_WORKSHOP` |
| Second demo shop | Business | Seller account for `DEMO_SECOND_SHOP`, pending [issue #17](https://github.com/ever-guild/AgentShelf/issues/17) |
| Demo buyer | Personal | Signs in at PayPal Sandbox and manually approves a checkout |

Create or reuse one sandbox REST app for each seller Business account; keep each app's Client ID and Secret with that seller account, and record its sandbox merchant ID; do not use live app credentials or a live merchant ID

For each seller app, switch the Developer Dashboard to Sandbox, open Apps & Credentials, select Create App, choose the seller's Business sandbox account, and save the app; copy the Client ID and Secret from that app's details and find the merchant ID in the seller sandbox account settings; repeat separately for the second seller

The buyer's sandbox login is used only by the owner during a manual approval; do not put buyer credentials in environment variables, `.env.local`, Render, GitHub Actions, chat, or the repository

Follow PayPal's [sandbox account guide](https://developer.paypal.com/sandbox-testing/accounts) and [REST API setup guide](https://developer.paypal.com/api/get-started/) for the current dashboard labels and credential locations

## Local configuration

If `.env.local` does not already exist, copy `.env.example` to create it; preserve any existing `.env.local`, then set these names from the two seller apps and seller accounts

```bash
if [ ! -f .env.local ]; then cp .env.example .env.local; fi
```

| Shop credential ref | App credentials | Seller merchant ID |
| --- | --- | --- |
| `DEMO_PHONE_WORKSHOP` | `PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP`, `PAYPAL_CLIENT_SECRET_DEMO_PHONE_WORKSHOP` | `DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID` |
| `DEMO_SECOND_SHOP` | `PAYPAL_CLIENT_ID_DEMO_SECOND_SHOP`, `PAYPAL_CLIENT_SECRET_DEMO_SECOND_SHOP` | `DEMO_SECOND_SHOP_PAYPAL_MERCHANT_ID` |

Set `APP_ORIGIN` to the HTTPS origin used by the demo, without a path, query, or fragment

Run the offline configuration-only check with Node.js 24

```bash
node --env-file-if-exists=.env.local scripts/paypal-preflight.mjs
```

This is a configuration-only check; it verifies that both seller credential groups and merchant IDs are present, that the two Client IDs and merchant IDs differ, and that `APP_ORIGIN` is an HTTPS origin; it does not verify credentials or make network requests

After entering sandbox credentials, optionally check that each app can obtain a sandbox OAuth token

```bash
node --env-file-if-exists=.env.local scripts/paypal-preflight.mjs --online
```

The online check sends one OAuth client-credentials request per seller app to PayPal's fixed sandbox host; it does not call Orders, capture a payment, register webhooks, or verify that a merchant ID belongs to its app; tokens and credential values are never printed; OAuth success proves only that each app credential pair can obtain a sandbox token; this preflight does not prove that the application's runtime payment integration works

## Existing Render service

Add the two seller credential groups, seller merchant IDs, and `APP_ORIGIN` to the existing AgentShelf web service's Environment settings in the Render Dashboard; keep the current service and database, do not change service configuration or plans for this setup, and never add the buyer's password

The script reads the current process environment and the optional local file loaded by the documented Node command; it does not read Render settings or fetch service variables; to check values held in Render, an operator must provide the required variables to the process through an approved secure mechanism

Checkout reads a shop's merchant ID from the database rather than from the environment, so run `npm run db:seed` again wherever you set or change `DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID`, [deployment.md](deployment.md#seed-the-demo-data) explains how on Render, then run `npm run smoke:checkout -- URL --wait` as described in [mcp.md](mcp.md#smoke-check)

## Webhooks

The webhook route is deployed, so each seller app's webhook can be registered; register it separately for each app, under that app's settings in the Developer Dashboard, with a Sandbox HTTPS URL that names the shop by its slug

| Shop credential ref | Webhook URL | Webhook ID variable |
| --- | --- | --- |
| `DEMO_PHONE_WORKSHOP` | `https://agentshelf-e5bk.onrender.com/api/paypal/webhooks/demo-phone-workshop` | `PAYPAL_WEBHOOK_ID_DEMO_PHONE_WORKSHOP` |
| `DEMO_SECOND_SHOP` | The same path with that shop's slug, once [issue #17](https://github.com/ever-guild/AgentShelf/issues/17) has seeded it | `PAYPAL_WEBHOOK_ID_DEMO_SECOND_SHOP` |
| Platform seller consent revocation | `https://agentshelf-e5bk.onrender.com/api/seller/paypal/connection/webhook` | `PAYPAL_PLATFORM_WEBHOOK_ID` |
| Platform Orders and captures | `https://agentshelf-e5bk.onrender.com/api/paypal/platform-webhooks` | `PAYPAL_PLATFORM_PAYMENT_WEBHOOK_ID` |

Register each platform row as its own webhook subscription under the same Sandbox Platform REST app. PayPal assigns a distinct Webhook ID to each listener URL; keep the consent-revocation ID separate from the payment-event ID. The platform payment listener verifies the exact raw body with `PAYPAL_PLATFORM_PAYMENT_WEBHOOK_ID`, selects only stored orders whose credential snapshot is `PAYPAL_PLATFORM`, and reconciles through the order's saved seller ID. It does not require a connection to remain ready to read a completed payment after revocation.

Subscribe the platform payment listener to these event names rather than to all events:

- `CHECKOUT.ORDER.APPROVED`
- `CHECKOUT.PAYMENT-APPROVAL.REVERSED`
- `PAYMENT.CAPTURE.COMPLETED`
- `PAYMENT.CAPTURE.DECLINED`
- `PAYMENT.CAPTURE.DENIED`
- `PAYMENT.CAPTURE.PENDING`
- `PAYMENT.CAPTURE.REFUNDED`
- `PAYMENT.CAPTURE.REVERSED`

PayPal assigns a webhook ID to each subscribed listener URL and delivers events generated by the selected REST app. See [PayPal webhook setup and verification](https://developer.paypal.com/api/rest/webhooks/rest/) and [Orders checkout webhook subscriptions](https://developer.paypal.com/payment-methods/webhooks/).

Subscribe to these events by name rather than to all events:

- `CHECKOUT.ORDER.APPROVED`
- `CHECKOUT.PAYMENT-APPROVAL.REVERSED`
- `PAYMENT.CAPTURE.COMPLETED`
- `PAYMENT.CAPTURE.DECLINED`
- `PAYMENT.CAPTURE.DENIED`
- `PAYMENT.CAPTURE.PENDING`
- `PAYMENT.CAPTURE.REFUNDED`
- `PAYMENT.CAPTURE.REVERSED`

Copy the Webhook ID that PayPal shows into the variable above, in the Render environment and in `.env.local`; a shop whose variable is unset answers `503`, and PayPal repeats those deliveries for up to 3 days

Test with a real sandbox payment, because PayPal's Webhooks Simulator produces events that cannot pass signature verification; the simulator can only show that the URL is reachable

Payments still settle without a webhook, more slowly, because the sweep described in [architecture.md](architecture.md#payment-reconciliation) checks open orders every few minutes

## Payment implementation

The buyer must manually approve on PayPal's sandbox page; a server-side capture runs only after PayPal reports the order as approved; an agent must never approve for the buyer; checkout creation and approval URL belong to [issue #6](https://github.com/ever-guild/AgentShelf/issues/6), capture and webhook handling belong to [issue #11](https://github.com/ever-guild/AgentShelf/issues/11), and payment proof operations belong to [issue #2](https://github.com/ever-guild/AgentShelf/issues/2)

The second demo shop's catalog and seed data remain pending [issue #17](https://github.com/ever-guild/AgentShelf/issues/17); the preflight's `DEMO_SECOND_SHOP` group prepares its future credential names only and does not implement that shop

## Dependencies

- [Issue #2](https://github.com/ever-guild/AgentShelf/issues/2): payment proof operations
- [Issue #6](https://github.com/ever-guild/AgentShelf/issues/6): sandbox Orders creation and approval URL
- [Issue #11](https://github.com/ever-guild/AgentShelf/issues/11): webhook endpoint, signature verification and event handling
- [Issue #17](https://github.com/ever-guild/AgentShelf/issues/17): second shop and its seed/configuration support
