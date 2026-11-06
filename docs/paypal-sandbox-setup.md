# PayPal sandbox setup

This guide prepares credentials for the current demo configuration; the application creates Orders once a shop has these credentials and a merchant ID, and does not yet process captures; the preflight only checks configuration and, with `--online`, sandbox OAuth credentials

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

Checkout reads a shop's merchant ID from the database rather than from the environment, so run `npm run db:seed` again wherever you set or change `DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID`, [deployment.md](deployment.md#seed-the-demo-data) explains how on Render, then run `npm run smoke:checkout` as described in [mcp.md](mcp.md#smoke-check)

## Webhooks and payment implementation

Do not register webhooks until the real HTTPS webhook route exists and is deployed under [issue #11](https://github.com/ever-guild/AgentShelf/issues/11); register each seller app's webhook separately and keep its webhook ID with that app's settings; the endpoint must verify signatures and be ready to handle events before registration

The buyer must manually approve on PayPal's sandbox page; a server-side capture may run only after verified PayPal approval, including when triggered by an authorized agent; an agent must never approve for the buyer or capture before approval; checkout creation and approval URL belong to [issue #6](https://github.com/ever-guild/AgentShelf/issues/6), capture and webhook handling belong to [issue #11](https://github.com/ever-guild/AgentShelf/issues/11), and payment proof operations belong to [issue #2](https://github.com/ever-guild/AgentShelf/issues/2)

The second demo shop's catalog and seed data remain pending [issue #17](https://github.com/ever-guild/AgentShelf/issues/17); the preflight's `DEMO_SECOND_SHOP` group prepares its future credential names only and does not implement that shop

## Dependencies

- [Issue #2](https://github.com/ever-guild/AgentShelf/issues/2): payment proof operations
- [Issue #6](https://github.com/ever-guild/AgentShelf/issues/6): sandbox Orders creation and approval URL
- [Issue #11](https://github.com/ever-guild/AgentShelf/issues/11): webhook endpoint, signature verification, event handling, and only then webhook registration
- [Issue #17](https://github.com/ever-guild/AgentShelf/issues/17): second shop and its seed/configuration support
