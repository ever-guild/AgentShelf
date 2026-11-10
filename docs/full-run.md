# Full run

How to run AgentShelf end to end on the deployed service, for the rehearsals in [#18](https://github.com/ever-guild/AgentShelf/issues/18). It links to the detailed guides and does not repeat them: [deployment.md](deployment.md), [paypal-platform-setup.md](paypal-platform-setup.md), [mcp.md](mcp.md) and [integrations.md](integrations.md). For a local copy without providers, see [DEVELOP.md](../DEVELOP.md#run-locally).

## What has and has not run against the real service

Verified on the deployed service, with the evidence linked:

- Two owner-registered shops connected through the PayPal platform app, both ready with different merchants ([#35](https://github.com/ever-guild/AgentShelf/issues/35)).
- One EUR 1 product checkout created through `/mcp` by a helper script, approved in PayPal Sandbox by a person, captured for the right seller, with both platform webhooks verified and stock decremented once ([#2](https://github.com/ever-guild/AgentShelf/issues/2), [#36](https://github.com/ever-guild/AgentShelf/issues/36)).
- Seller MCP from Claude Code: shop creation, grants, CSV import, review, publication, stock and denials ([rehearsal](seller-agent-rehearsal.md#external-claude-code-session)).
- Migrations and the demo seed on the deployed database.

Not yet run against the real service. Treat these as unverified until a step below passes:

- A repair booking with a real Sandbox deposit, and the Bryntum schedule showing it. A connected workshop needs technicians first ([#47](https://github.com/ever-guild/AgentShelf/issues/47)).
- Reading a real price-list photo with the model, search indexing and demand insights on Render, and the Render Workflows task ([#48](https://github.com/ever-guild/AgentShelf/issues/48)).
- Claude (claude.ai) and ChatGPT connecting to the buyer `/mcp`.
- PayPal Catalog Products sync for a platform-connected shop. The JS SDK v6 storefront button was paid once by a person on 10 November, see [capabilities.md](capabilities.md).
- AG Studio with a key, including the AI assistant, which needs a key for "AG Studio Pro with AI".
- The screen reader and keyboard passes.

## What has to exist

| Item | Owner | Where the value goes | What breaks without it |
| --- | --- | --- | --- |
| PayPal Sandbox Platform REST app and its two webhook subscriptions | PayPal owner | `PAYPAL_PLATFORM_*`, `PAYPAL_PARTNER_ATTRIBUTION_ID` and both webhook IDs on the web service, see [platform setup](paypal-platform-setup.md) | Seller consent, checkout and deposits answer `PAYMENT_NOT_CONFIGURED`; webhook events cannot be verified, so payments settle only through the buyer's return and the sweep |
| At least one owner shop with a **ready** PayPal connection, with published products and an explicit stock policy | Shop owner | `/seller/paypal-connection` and `/seller/catalog` | Checkout answers `PAYMENT_NOT_CONFIGURED` or `PRODUCT_UNAVAILABLE` |
| Technicians with working hours on the connected workshop | Shop owner | `/seller/schedule`, tracked in [#47](https://github.com/ever-guild/AgentShelf/issues/47) | `get_slots` returns nothing, so no booking or deposit |
| Sandbox personal buyer | PayPal owner | Nowhere. The login is typed at PayPal by a person | Nobody can approve a payment |
| AI provider key with a low monthly spend limit | Captain | `AGENT_SHELF_AI_PROVIDER`, `AGENT_SHELF_AI_PROVIDER_BASE_URL`, `AGENT_SHELF_AI_PROVIDER_API_KEY` on the web service and workflow, and in `.env.local` | Photo import, descriptions, search indexing and dashboard notes stop. CSV import and exact-word search still work. Search reports `degraded` ([#48](https://github.com/ever-guild/AgentShelf/issues/48)) |
| `APP_SIGNING_SECRET`, `APP_ORIGIN` | Render owner | Render environment | Seller sessions and order status tokens fail |
| Render workflow service `agentshelf-import`, `RENDER_WORKFLOW_SLUG`, `RENDER_API_KEY` (optional) | Render owner | See [deployment.md](deployment.md#render-workflows-for-photo-import) | Photo reading runs inside the web service, and the Render prize integration is missing |
| Paid plan decision for Postgres, which expires on 5 December 2026 | Render owner | Render Dashboard | The database is gone during judging |
| AG Studio trial key, checked for AI | AG Studio owner | `AG_STUDIO` on the web service | The dashboard shows a trial watermark and console licence errors. The assistant stays off |
| Bryntum track decision. The code uses 8.0 Community, which needs no key | Captain | `NEXT_PUBLIC_BRYNTUM_LICENSE_KEY` only on a Business track | Nothing breaks on Community. The prize may need confirming |
| Postman workspace | Anyone | Import [docs/postman](postman/README.md) | Only the collection is unrun |
| Devpost entry, video, team | Representative | Devpost | No submission |

The legacy direct-merchant settings (`PAYPAL_CLIENT_ID_DEMO_*`, `DEMO_*_PAYPAL_MERCHANT_ID`, `DEMO_*_SELLER_CODE`) only make the two seeded demo shops payable and let `smoke:checkout`, `smoke:booking` and `smoke:import` run. They are optional diagnostics, not the product path.

Never put the buyer's password, a key or a secret in the repository, a chat or a screenshot.

## Starting state

Use the deployed service, `URL=https://agentshelf-e5bk.onrender.com`. Record the commit from `/api/health` first.

Do **not** run `npm run demo:reset` or `npm run db:seed` on the deployed database to start clean. The database holds owner shops, connected merchants and paid orders. `demo:reset` refuses a database with owner-created shops, and a reseed is only needed when the database is recreated. Run them only on your own disposable database.

Instead, before each rehearsal:

- Pick the connected shop you will use and confirm `/seller/paypal-connection` shows it ready.
- In `/seller/catalog`, top up the tracked quantity of the products you will buy with **Adjust quantity**, and give any new product an explicit stock policy. Each adjustment is versioned and audited.
- Unpublish leftover test products from earlier runs, and note any open or `review_required` orders. Do not edit rows in the database.

## The run

1. **Starting state.** As above. Note the shop, the products and their stock.
2. **Health.** `curl -fsS URL/api/health/ready` returns 200.
3. **Credentials.** On a machine with the platform values, `npm run paypal:platform-preflight` reports them present, see [platform setup](paypal-platform-setup.md#safe-local-check). The online check is optional and makes one OAuth request. The shop's connection page shows ready.
4. **Seller upload.** Sign in at `URL/seller/owner-sign-in`, with PayPal or the owner's password. Upload a price list at `/seller/imports`. A CSV works without the model; a photo needs the configured AI provider ([#48](https://github.com/ever-guild/AgentShelf/issues/48)). Correct a row, and check that an unclear price stays blocked. `npm run smoke:import -- URL` only covers the legacy demo shop sign-in.
5. **Publish.** Publish the reviewed rows, then open `/seller/catalog`. Each new physical product shows "Stock decision required" until you choose a tracked quantity or untracked. Record the PayPal Catalog sync state of each product, and any `failed` with its reason, since Catalog Products has not run for a platform shop.
6. **MCP search.** Add `URL/mcp` as a connector in Claude, then in ChatGPT, as [mcp.md](mcp.md) explains. Ask each for a product from the uploaded list, and for one that does not exist. As the control, run the direct tool calls in [Check a connected shop](mcp.md#check-a-connected-shop). `npm run smoke:mcp -- URL/mcp` checks only the seeded demo shops. A pass of a script is not evidence for either assistant.
7. **Purchase.** Ask the assistant to buy the product. It must return an approval link and never pay. Approve as the sandbox buyer. Expect the status to reach `paid`, the order to show in the seller area and available stock to drop by one. `npm run smoke:checkout -- URL/mcp --wait` exercises only the legacy demo shop app.
8. **Booking with deposit.** A shop registered by its owner has no technicians yet: set one up first on `/seller/schedule`, with a made-up name ([#47](https://github.com/ever-guild/AgentShelf/issues/47)). Ask for a free repair slot, book it and approve the deposit. Expect a hold for 15 minutes, then `confirmed` after the capture. `npm run smoke:booking -- URL --wait` exercises only the seeded demo workshop with the legacy app.
9. **Scheduler.** Open `/seller/schedule`. The booking appears within about 5 seconds, under the technician, in Riga time.
10. **Dashboard and insights.** Open `/seller/dashboard`. Check orders, payments, bookings and demand. Search for something missing, such as a MagSafe charger, and see it in the demand table. Press the insight button. It needs the model, and a note naming a number it cannot support is rejected.
11. **Storefront.** Open the connected shop at `URL/shops/<shop-slug>` on desktop and at 375 px. Buy a product with the PayPal button. If the SDK fails, the page offers the approval link instead.
12. **Failure paths.** Cancel a payment, send an invalid webhook, try to buy a product with no available units, and try one shop's order from another shop's session. Record each as PASS, FAIL, BLOCKED or INCONCLUSIVE.

## What to record for each of the three rehearsals

- Date and time, the commit from `/api/health`, and the Render deploy ID.
- Per step above: result, a timestamp and sanitized evidence such as a screenshot or log line. Show no customer data, keys or buyer logins.
- The PayPal order and capture IDs of the sandbox payments, and the webhook delivery shown in the app's dashboard.
- Which assistant, with its version or plan, and whether the connector worked without help.
- Model calls used and the cost against the spend limit.
- Every defect with severity and the steps to reproduce.
- The state the next rehearsal starts from: stock before and after, top-ups made, leftover products and orders.

Three consecutive passes close [#18](https://github.com/ever-guild/AgentShelf/issues/18). A single step that depends on a missing account or an open prerequisite is BLOCKED, not skipped.
