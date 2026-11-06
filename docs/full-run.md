# Full run

How to run AgentShelf end to end once the accounts exist, for the rehearsals in [#18](https://github.com/ever-guild/AgentShelf/issues/18). It links to the detailed guides and does not repeat them: [deployment.md](deployment.md), [paypal-sandbox-setup.md](paypal-sandbox-setup.md), [mcp.md](mcp.md) and [integrations.md](integrations.md).

## What has never run against the real service

Everything below that touches PayPal, a model, AG Studio or Bryntum with a key has been tested only against stand-ins or without a key. Code on `main` is not a verified integration until a step here has passed on the deployed service. Treat these as unverified:

- Any PayPal call: Orders create, approval, capture, webhooks, Catalog Products with caller-chosen record IDs, and the JS SDK v6 buttons with `payment_source.paypal.experience_context`.
- Reading a real price list photo with the model, and the Render Workflows task on Render.
- Search indexing on the deployed database: `unaccent` may be refused by Render Postgres, and then the new version does not start.
- Claude and ChatGPT connecting to `/mcp`.
- AG Studio with a key, including the AI assistant, which needs a key for "AG Studio Pro with AI".
- Bryntum on the deployed service and the screen reader and keyboard passes.
- The deployed database taking migrations 0004 to 0009.

## What has to exist

| Item | Owner | Where the value goes | What breaks without it |
| --- | --- | --- | --- |
| PayPal sandbox seller app and Business account for the phone workshop, with the permission to create and manage products enabled | PayPal owner ([#33](https://github.com/ever-guild/AgentShelf/issues/33)) | `PAYPAL_CLIENT_ID_DEMO_PHONE_WORKSHOP`, `PAYPAL_CLIENT_SECRET_DEMO_PHONE_WORKSHOP`, `DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID` in Render and `.env.local` | Checkout, booking deposit and storefront buttons answer `PAYMENT_NOT_CONFIGURED`. Catalog sync shows `not_configured` |
| Same for the second shop | PayPal owner | The same names with `DEMO_SECOND_SHOP`, plus `DEMO_SECOND_SHOP_SELLER_CODE` | The candle shop cannot take payment, and the seed cannot give the shops different merchants |
| Sandbox personal buyer | PayPal owner | Nowhere. The login is typed at PayPal by a person | Nobody can approve a payment |
| Webhook per seller app, with the eight events from [paypal-sandbox-setup.md](paypal-sandbox-setup.md#webhooks) | PayPal owner | `PAYPAL_WEBHOOK_ID_DEMO_PHONE_WORKSHOP`, `PAYPAL_WEBHOOK_ID_DEMO_SECOND_SHOP` | The webhook answers `503`. Payments still settle through the return page and the sweep, but slower |
| Anthropic key with a low monthly spend limit | Captain | `ANTHROPIC_API_KEY` on the web service and the workflow, and `.env.local` | Photo import, descriptions, search indexing and dashboard notes stop. CSV import and exact-word search still work. Search reports `degraded` |
| `APP_SIGNING_SECRET`, `APP_ORIGIN` | Render owner | Render environment | Seller sessions and order status tokens fail |
| `DEMO_PHONE_WORKSHOP_SELLER_CODE` | Render owner | Render environment | Nobody can sign in to the seller area, and `smoke:import` cannot run |
| `DEMO_ENVIRONMENT=true` | Render owner | Render environment | `npm run demo:reset` refuses to run |
| Render workflow service `agentshelf-import`, `RENDER_WORKFLOW_SLUG`, `RENDER_API_KEY` (optional) | Render owner | See [deployment.md](deployment.md#render-workflows-for-photo-import) | Photo reading runs inside the web service, and the Render prize integration is missing |
| Paid plan decision for Postgres, which expires on 5 December 2026 | Render owner | Render Dashboard | The database is gone during judging |
| AG Studio trial key, requested from Nov 7 to Nov 10, checked for AI | AG Studio owner | `AG_STUDIO` in Render and `.env.local` | The dashboard shows a trial watermark and console licence errors. The assistant stays off |
| Bryntum track decision. The code uses 8.0 Community, which needs no key | Captain | `NEXT_PUBLIC_BRYNTUM_LICENSE_KEY` only on a Business track | Nothing breaks on Community. The prize may need confirming |
| Postman workspace | Anyone | Import [docs/postman](postman/README.md) | Only the collection is unrun. The smoke scripts cover the same ground |
| Devpost entry, video, team | Representative | Devpost | No submission |

Never put the buyer's password, a key or a secret in the repository, a chat or a screenshot.

## The run

Use the deployed service, `URL=https://agentshelf-e5bk.onrender.com`. Record the commit from `/api/health` first.

1. **Clean database.** A fresh Render database seeds itself on the first start. For a used one, set `DEMO_ENVIRONMENT=true` and run `npm run demo:reset` in the Render Shell. Expect the two demo shops, 8 products, 2 technicians and 8 demand fixtures. `npm run smoke:demo -- URL/mcp` should pass.
2. **Health.** `curl -fsS URL/api/health/ready` returns 200. If the deploy failed on `unaccent`, record it as a blocker.
3. **Credentials.** Run `node --env-file-if-exists=.env.local scripts/paypal-preflight.mjs --online`, then `npm run db:seed` in the Render Shell so the merchant IDs reach the database. See [paypal-sandbox-setup.md](paypal-sandbox-setup.md).
4. **Seller upload.** Sign in at `URL/seller/sign-in` with the seller code. Upload a price list photo at `/seller/imports`. Expect rows in the table within about a minute. Correct a row, and check that an unclear price stays blocked. `npm run smoke:import -- URL` does the upload check, and also with `test/fixtures/price-lists/ambiguous.png`.
5. **Publish.** Publish the reviewed rows. Open `/seller/catalog`. Each product moves from `pending` to `synced`. Record any `failed` with its reason, since Catalog Products has never run against PayPal.
6. **MCP search.** Add `URL/mcp` as a connector in Claude, then in ChatGPT, as [mcp.md](mcp.md) explains. Ask each for a product from the uploaded list, and for one that does not exist. Run `npm run smoke:mcp -- URL/mcp` as the control. A pass of the script is not evidence for either assistant.
7. **Purchase.** Ask the assistant to buy the product. It must return an approval link and never pay. Approve as the sandbox buyer. Expect the status to reach `paid`, and the order to show in the seller area. Also run `npm run smoke:checkout -- URL/mcp --wait`.
8. **Booking with deposit.** Ask for a free repair slot, book it and approve the deposit. Expect a hold for 15 minutes, then `confirmed` after the capture. `npm run smoke:booking -- URL --wait` does the same.
9. **Scheduler.** Open `/seller/schedule`. The booking appears within about 5 seconds, under the technician, in Riga time.
10. **Dashboard and insights.** Open `/seller/dashboard`. Check orders, payments, bookings and demand. Search for something missing, such as a MagSafe charger, and see it in the demand table. Press the insight button. It needs the model, and a note naming a number it cannot support is rejected.
11. **Storefront.** Open `URL/shops/demo-phone-workshop` on desktop and at 375 px. Buy a product with the PayPal button. If the SDK fails, the page offers the approval link instead.
12. **Failure paths.** Cancel a payment, send an invalid webhook, and try one shop's order from another shop's session. Record each as PASS, FAIL, BLOCKED or INCONCLUSIVE.

## What to record for each of the three rehearsals

- Date and time, the commit from `/api/health`, and the Render deploy ID.
- Per step above: result, a timestamp and sanitized evidence such as a screenshot or log line. Show no customer data, keys or buyer logins.
- The PayPal order and capture IDs of the sandbox payments, and the webhook delivery shown in the app's dashboard.
- Which assistant, with its version or plan, and whether the connector worked without help.
- Model calls used and the cost against the spend limit.
- Every defect with severity and the steps to reproduce.
- The state the next rehearsal starts from, and whether `demo:reset` was needed.

Three consecutive passes close [#18](https://github.com/ever-guild/AgentShelf/issues/18). A single step that depends on a missing account is BLOCKED, not skipped.
