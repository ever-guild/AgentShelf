# Architecture notes

The decisions and shared contracts that catalog, MCP, checkout and booking all build on.

## Database

- **Engine:** PostgreSQL 17, tested on 17.11. The migrations create the `btree_gist` extension.
- **Provider:** Render Postgres, because all hosting is already on Render. The code is plain Postgres with no provider-specific features, so moving to Supabase or Neon means changing `DATABASE_URL` and nothing else. [deployment.md](deployment.md) covers how it runs there.
- **Access:** [Drizzle ORM](https://orm.drizzle.team) over `pg`. The schema is [`src/server/db/schema.ts`](../src/server/db/schema.ts).
- **Migrations:** SQL files in [`drizzle/`](../drizzle), generated from the schema with `npm run db:generate` and applied with `npm run db:migrate`. [`0001_invariants.sql`](../drizzle/0001_invariants.sql) is hand-written, for constraints Drizzle cannot express.

### Local setup

```bash
createdb agentshelf_dev
cp .env.example .env.local   # then fill in the values below
npm run db:migrate
npm run db:seed
npm test
```

Migrating and seeding are safe to repeat. The seed updates its own fixed rows and leaves everything else alone. It is a manual step, not part of a deploy, so a redeploy never resets demo data.

`npm test` needs a real Postgres server and creates and drops its own temporary database on it, never touching the database named in `TEST_DATABASE_URL`. It fails when that variable is missing rather than skipping tests. `npm run test:unit` runs the tests that need no database.

### Environment variables

| Variable | Read by | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | app, `db:migrate`, `db:seed` | Postgres connection string |
| `TEST_DATABASE_URL` | `npm test` | Connection string for a server where tests may create and drop databases |
| `APP_SIGNING_SECRET` | app | At least 32 random characters. Signs seller sessions and order status tokens, and changing it invalidates them |
| `APP_ORIGIN` | app | The public origin, such as `http://localhost:3000` locally. On Render it falls back to `RENDER_EXTERNAL_URL` |
| `PAYPAL_CLIENT_ID_<REF>`, `PAYPAL_CLIENT_SECRET_<REF>` | app, from [#6](https://github.com/ever-guild/AgentShelf/issues/6) | Sandbox credentials for the shop whose `paypal_credential_ref` is `<REF>`. [#2](https://github.com/ever-guild/AgentShelf/issues/2) may change this once the merchant model is proven |
| `PAYPAL_WEBHOOK_ID_<REF>` | app | The webhook subscription on that seller's app. [paypal-sandbox-setup.md](paypal-sandbox-setup.md#webhooks) explains how to register it. Until it is set, that shop's webhook deliveries get `503` and PayPal repeats them |
| `ANTHROPIC_API_KEY` | app, workflow | The model key for reading photos and suggesting descriptions. Without it, photo upload says so and CSV upload still works |
| `RENDER_WORKFLOW_SLUG`, `RENDER_API_KEY` | app | Optional. With both, a photo is read by a Render Workflows task. Without them, it is read inside the web process. [deployment.md](deployment.md#render-workflows-for-photo-import) explains how to set this up |
| `DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID` | `db:seed` | Optional. The demo shop's sandbox merchant. Its checkout returns `PAYMENT_NOT_CONFIGURED` until this is set and the seed has run again, because checkout reads the merchant from the database |
| `DEMO_PHONE_WORKSHOP_SELLER_CODE` | `db:seed` | Optional. The demo shop's seller access code, stored only as a hash. Nobody can sign in until this is set |

## Rules the data model enforces

Most of these are database constraints, so they hold however a row gets written.

| Rule | Enforced by |
| --- | --- |
| Money is an integer number of minor units | `integer` columns, [`money.ts`](../src/server/domain/money.ts) for arithmetic and decimal conversion. EUR is the only supported currency for now |
| A row cannot mix shops | Composite foreign keys on `(id, shop_id)` from order lines and bookings |
| PayPal order, capture, product and webhook event IDs, merchant IDs and idempotency keys are unique | Unique constraints, across all shops |
| A published product has a price, and a published service also has a duration and deposit | Check constraints. A draft may leave these unknown |
| An order cannot be `paid` without a capture ID | `orders_paid_requires_capture` |
| An order's amount, currency and recipient never change, and its lines are never edited or deleted | `orders_terms_immutable` and `order_lines_immutable` triggers |
| One technician cannot have overlapping held or confirmed bookings | `bookings_technician_no_overlap` exclusion constraint |
| A booking cannot be `confirmed` without the capture recorded on its own order | `bookings_confirmed_requires_capture`, `bookings_order_capture_fk` |

Payment state lives on `orders` and booking state on `bookings`. Instants are stored in UTC, and a shop's IANA timezone (`Europe/Riga` for the demo shop) is used for display.

`shops.paypal_credential_ref` names a credential set held in environment variables and is never the credential itself. It and `shops.paypal_merchant_id` stay on the server.

## Service contracts

The Zod schemas in [`src/server/contracts/commerce.ts`](../src/server/contracts/commerce.ts) are the source of truth, shared by HTTP routes and MCP tools. Inputs are strict: a request carrying a total, price, merchant or any other unknown field is rejected, not ignored. Amounts are integer minor units and instants are ISO 8601 with an offset.

| Tool | Input | Result | Implemented in |
| --- | --- | --- | --- |
| `search_products` | `query`, `location?`, `maxPriceMinor?`, `currency?`, `limit?` | `products[]`: `productId`, `shopId`, `shopName`, `location`, `kind`, `title`, `description`, `priceMinor`, `currency`, `availability`, `serviceDurationMinutes`, `depositMinor` | [#5](https://github.com/ever-guild/AgentShelf/issues/5), [#10](https://github.com/ever-guild/AgentShelf/issues/10) |
| `get_slots` | `shopId`, `serviceId`, `from`, `to` | `slots[]`: `slotId`, `technicianId`, `startsAt`, `endsAt`, `timezone` | [#12](https://github.com/ever-guild/AgentShelf/issues/12) |
| `book_slot` | `slotId`, `serviceId`, `idempotencyKey` | `bookingId`, `orderId`, `expiresAt`, `approvalUrl`, `depositMinor`, `remainingMinor`, `currency`, `statusToken` | [#12](https://github.com/ever-guild/AgentShelf/issues/12) |
| `create_checkout` | `items[]`: `productId`, `quantity`; `idempotencyKey` | `orderId`, `totalMinor`, `currency`, `approvalUrl`, `statusToken` | [#6](https://github.com/ever-guild/AgentShelf/issues/6) |
| `get_order_status` | `orderId`, `statusToken` | `orderId`, `paymentStatus`, `totalMinor`, `currency`, `booking`, `updatedAt` | [#11](https://github.com/ever-guild/AgentShelf/issues/11) |

Services throw a `ServiceError` with a stable code from [`errors.ts`](../src/server/errors.ts). Its message and details are safe to return to a client.

[mcp.md](mcp.md) covers the connector and how to add it to Claude and ChatGPT.

These server pieces already exist for the issues above to build on:

- `createCheckout` is the one checkout entry point for MCP and the storefront. See [Checkout](#checkout).
- `reconcileOrder` is the one place that decides what a PayPal order means for a stored one. See [Payment reconciliation](#payment-reconciliation).
- `createImport` and the review functions around it turn a price list into accepted draft rows. See [Catalog import](#catalog-import).
- `getOrderStatus` reads an order's stored state for the holder of its capability.
- `quoteCheckout` resolves a cart to authoritative lines, total and recipient, and rejects mixed shops and products that are not on sale.
- `searchProducts` matches text across all shops, and `getPublishedProduct` and `listPublishedProducts` read the public catalog.
- `issueOrderStatusToken` and `verifyOrderStatusToken` provide the order capability. The token is derived with an HMAC, so an idempotent retry returns the same one and none are stored.

## Checkout

[`createCheckout`](../src/server/services/checkout.ts) turns a cart into a PayPal sandbox order, for [#6](https://github.com/ever-guild/AgentShelf/issues/6). Everything specific to PayPal is in [`paypal/orders.ts`](../src/server/paypal/orders.ts).

**Status:** tested with the real SDK against a stand-in for PayPal, and against the real sandbox only as far as a refused token request. No real PayPal order has been created, because the sandbox credentials from [#33](https://github.com/ever-guild/AgentShelf/issues/33) do not exist yet. Run `npm run smoke:checkout -- URL --wait` once they do. It creates one sandbox order through a running `/mcp` endpoint, reads the recipient back from PayPal and waits for a person to pay.

1. A repeated `idempotencyKey` is answered from the stored order, whatever has happened to prices or stock since.
2. A new key is quoted from stored data and saved as a `pending` order with its lines, before PayPal hears about it.
3. PayPal is asked to create the order, built only from what was stored, with the shop's merchant as `payee` and the local order ID as `PayPal-Request-Id`.
4. PayPal's answer must be the order that was asked for: the same reference, recipient, amount, currency and intent, with a link to PayPal's sandbox checkout for that order. Only then is the link stored and returned.

An approval link is not payment. The order stays `pending`, and only [reconciliation](#payment-reconciliation) may move it on.

| Code | When | What the caller does | Stored order |
| --- | --- | --- | --- |
| `PRODUCT_NOT_FOUND`, `PRODUCT_UNAVAILABLE`, `PRODUCT_REQUIRES_BOOKING`, `MIXED_SHOPS`, `UNSUPPORTED_CURRENCY` | The cart cannot be sold | Changes the cart | None |
| `PAYMENT_NOT_CONFIGURED` | The shop has no merchant or credentials, or PayPal refuses them (`401`, `403`, `PAYEE_NOT_CONSENTED`) | Nothing, the seller has to fix it | None, or `pending` if PayPal refused |
| `PAYMENT_TIMEOUT` | No answer within 12 seconds per request | Retries with the same key | `pending` |
| `PAYMENT_UNAVAILABLE` | Any other unknown outcome: `5xx`, `409`, `429`, a network failure, an unreadable response | Retries with the same key | `pending` |
| `PAYMENT_DECLINED` | PayPal refused this order (`400`, `422`), or later refused its capture | Uses a new key once the cause has changed | `failed` |
| `CHECKOUT_NEEDS_REVIEW` | PayPal's answer is not the requested order, or a retry came more than 6 hours after the first attempt | Starts again with a new key if nothing was paid | `review_required` |
| `IDEMPOTENCY_CONFLICT` | The key was used for a different cart | Uses a new key | Unchanged |

Retrying is safe because PayPal keeps a `PayPal-Request-Id` for 6 hours, so repeating one returns the first order. The SDK itself never retries. Past 6 hours the service stops repeating the request, because PayPal could then create a second order. Starting again cannot lead to two payments, since the first attempt's link never reached anyone.

Provider details go to the server log only, as short codes: status, name, `debug_id` and issue names. An SDK error is never logged whole, because its request holds the seller's authorization header.

The SDK keeps a failed token exchange as a rejected promise and rethrows it on every later call without sending a request, so `createPayPalProvider` replaces a client after any failure. Otherwise one network failure would stop a seller's payments until a restart.

The merchant model is the candidate from [paypal-sandbox-proof.md](paypal-sandbox-proof.md): each seller has its own REST app and is its own `payee`. [#2](https://github.com/ever-guild/AgentShelf/issues/2) has not proven it yet. If it settles on another model, `createPayPalProvider` and the `payee` in `buildOrderRequest` are what change.

## Payment reconciliation

[`reconcileOrder`](../src/server/services/payment-reconciliation.ts) keeps a stored order in line with PayPal, for [#11](https://github.com/ever-guild/AgentShelf/issues/11).

**Status:** tested with the real SDK against a stand-in for PayPal, and on a production build against the real sandbox only as far as refused credentials. No real payment or real webhook has gone through it, because the credentials from [#33](https://github.com/ever-guild/AgentShelf/issues/33) do not exist yet. A real signature in particular cannot be tested any other way.

**Every trigger is only a reason to ask.** The buyer's return, a verified webhook and the sweep all call the same function, which reads the order from PayPal and acts on that. What an event claims never changes anything, so events can arrive in any order, any number of times, with the same result.

| PayPal reports | Stored order becomes | Notes |
| --- | --- | --- |
| Waiting for the buyer | Stays as it is | `cancelled` if the buyer came back through the cancel link |
| `APPROVED` | `approved`, then captured | The one thing that triggers a capture. Approval is never `paid` |
| `COMPLETED`, capture `COMPLETED` for the stored amount | `paid`, with the capture ID | The only way to `paid`. The payment-confirmed hook runs here |
| `COMPLETED`, capture `PENDING` | `approved`, with the capture ID | Becomes `paid` when PayPal completes the capture |
| `COMPLETED`, capture `DECLINED` or `FAILED`, or a capture PayPal refuses (`400`, `422`) | `failed` | |
| `VOIDED` | `cancelled` | |
| Another recipient, amount, currency, reference or intent, several captures, a refunded capture, a different capture than the stored one | `review_required` | Stays there until a person looks. It is never asked about or captured again |

**A second charge cannot happen.** A capture is only sent when PayPal has just reported the order as `APPROVED` and it is not paid here. Its `PayPal-Request-Id` is fixed per order, so a repeat returns the first result, and PayPal allows one capture per order in any case. Its answer is not trusted either: the order is read again. An unknown outcome leaves the order `approved` for the next reconciliation.

**A cancellation is not final.** The cancel link counts only if PayPal agrees the order was not approved. A buyer who goes back and approves still pays, and the order moves on.

**The buyer's return:** `/checkout/return` and `/checkout/cancel` reconcile, then redirect to `/checkout/result`, which only reads the stored state. The links carry the order's status capability, so an order identifier alone does nothing and shows nothing. The capability is a bearer token in a URL, so these pages send no referrer and are not indexed.

**Webhooks:** `POST /api/paypal/webhooks/<shop-slug>`, one URL per shop because each seller's app has its own subscription. The signature is checked by PayPal's verification endpoint against the exact bytes received, before anything else is trusted.

| Answer | When | What PayPal does |
| --- | --- | --- |
| `200` | Handled, a duplicate, or an event for no order of this shop | Stops |
| `400` | Not a verified PayPal event. Nothing is stored | Repeats, to no effect |
| `404`, `413` | No such shop, or a body over 256 KiB | Repeats, to no effect |
| `503` | The webhook is not configured, verification could not run, or the order could not be settled | Repeats, up to 25 times over 3 days, and a repeat picks up where this one stopped |

Each delivery is recorded in `webhook_receipts` once, by its event ID. A receipt keeps identifiers and statuses only, because order events carry the payer's name, email and address.

**The sweep** settles what nothing else has: a buyer who approved and closed the tab, a capture whose outcome was lost, a shop with no webhook registered. It runs every 5 minutes in the server process, from [`instrumentation.ts`](../src/instrumentation.ts), and only calls `reconcileOrder`. It is bounded: 20 orders per pass, skipping orders under 2 minutes old, and asking less often as an order ages, up to one twelfth of its age. After 72 hours an open order is closed: `pending` becomes `cancelled`, and `approved` becomes `review_required`, because a person has to look at it.

**The payment-confirmed hook:** `onPaymentConfirmed` in `ReconcileDeps` runs inside the transaction that marks an order paid, exactly once per order. It does nothing yet. [#12](https://github.com/ever-guild/AgentShelf/issues/12) confirms a booking there, and later notifications can start from it. If it throws, the order stays unpaid here and the next reconciliation tries again, so a hook that cannot fulfil an order, such as a booking whose hold has expired, must record that rather than throw. The money has been captured by then, and [#12](https://github.com/ever-guild/AgentShelf/issues/12) owns what happens next.

**The status read:** `getOrderStatus` follows [paypal-order-status-contract.md](paypal-order-status-contract.md). It reads stored state only, and a missing order and a wrong capability get the same `ORDER_STATUS_UNAVAILABLE`.

## Catalog import

The seller's way in, for [#8](https://github.com/ever-guild/AgentShelf/issues/8): a photo or a CSV becomes draft rows, and the seller corrects them at `/seller/imports`. Nothing here reaches a buyer. A draft only becomes a product through publication, which is [#9](https://github.com/ever-guild/AgentShelf/issues/9).

**Status:** the CSV path is complete. The photo path has run through the real SDK and a real local Render Workflows server against a stand-in for the Claude API, and no real model has read a photo yet, because no key is configured. `npm run smoke:import -- URL` does that, and for the sample photos it checks what was read against what is printed.

**Two ways in, one model.** Both produce the same draft rows, reviewed by the same rules.

| | CSV | Photo |
| --- | --- | --- |
| Reader | [`csv.ts`](../src/server/imports/csv.ts), deterministic, no model | Claude, through [`claude.ts`](../src/server/ai/claude.ts) |
| When | During the upload, so the table opens at once | In a background run |
| Limits | 1 MB, 500 rows | 7 MB, 500 rows, 3 waiting and 30 a day per shop, since each costs a model call |
| A bad file | Refused with what to fix, and nothing stored | Refused by its bytes. A file's name and declared type do not decide |

**A price is never invented.** A model returns the price as printed, and [`price-text.ts`](../src/server/imports/price-text.ts) turns that text into minor units, the same as for a CSV cell or a seller's edit. It accepts only what has one meaning. `9,90`, `1 200,50` and `12,-` read as amounts. `1.200` could be 1200 or 1.20, and `from 20`, `20-30` and `free` are not one price, so those stay unknown and the row shows what the list said. A missing currency also stays unknown, until the seller states one. A model has no field for a deposit.

**Text in a source is data.** The system prompt says so, and a model has no tools, so the worst a hostile photo can do is produce wrong rows, which a person reads before accepting. A reply is judged by its stop reason and then validated against a strict schema, like any other input.

**The model:** `claude-opus-5-5` at `medium` effort, with `fallbacks: "default"`, so a safety classifier declining a harmless list is retried on the model the API recommends. The job records the model that actually answered and the prompt version (`price-list-v1`). [`ai/types.ts`](../src/server/ai/types.ts) is all the import code knows, so another provider means another adapter.

**A row and the gate:**

- Blockers stop a row from being accepted: no name, no kind, no price, no currency or a currency other than the shop's, and for a service no duration or deposit.
- Warnings ask for a look without blocking: what a model marked as uncertain, a row with extra cells, the same name twice. They stop a row from being accepted in bulk. Editing the field clears its warning.
- Finishing the review needs every row accepted or removed, and at least one accepted.
- `import_rows_accepted_is_complete` and its neighbours hold accepted rows to a published product's rules, so a row with no price cannot be `accepted` whatever code writes it.
- A priced option becomes its own row, because a product has one price and an order line names one product.

**For [#9](https://github.com/ever-guild/AgentShelf/issues/9):** publication reads the `accepted` rows of a `completed` import. A row holds a title, kind, price in the shop's currency, and for a service its duration and deposit. `description` is the source's words, and `description_en` and `description_lv` are the seller's chosen text. Rows are drafts, to be deleted once published.

**One result, whatever happens to a run.** A background run receives only a job ID, and the job names its shop. Composite foreign keys stop a row or a photo from sitting under another shop's job.

| What happens | Result |
| --- | --- |
| The same job is delivered twice | The second finds it taken or finished, and does nothing. No second model call |
| A run dies, or the server restarts | Its lease runs out after 6 minutes, and the sweep starts it again |
| A run that lost its lease finishes late | It no longer holds the job's token, so it writes nothing. `import_rows_job_id_position_unique` backs this up |
| The model answers with something unusable, or does not answer | The job is queued again without any row stored, up to 3 attempts, then `failed` with a message and a retry button |
| The model refuses, or the key is rejected | `failed` at once, because repeating costs money and changes nothing |
| Nothing ever picks the job up | `failed` after 15 minutes |

**Runners:** with `RENDER_WORKFLOW_SLUG` and `RENDER_API_KEY` set, [`workflows/main.ts`](../workflows/main.ts) runs the job as a Render Workflows task, whose retry policy gives the 3 attempts. Otherwise the web process runs it, two at a time, with the same function and the same retries. The idempotency key changes only when the job does, so restarting a job that has not moved cannot start a second run.

**Keeping the photo:** a photo is stored in `import_sources`, because the web service and a workflow run share no disk, and a run's arguments are limited to 4 MB. **It is deleted when the seller finishes the review, or 72 hours after upload, whichever comes first.** The sweep enforces the second, and a job left with no photo tells the seller to upload it again. The rows of a review stay when its photo goes. The browser redraws a photo before uploading it, which shrinks it to what a model can use and drops its location metadata. A CSV is not kept at all.

**Suggestions:** a seller can ask for English and Latvian descriptions, in batches of 25. They are generated from the row's own words and stored as editable text, and never overwrite what a seller wrote. A suggestion with a number the row does not contain, such as `5000 mAh`, is dropped and the row says so. That catches the checkable inventions, and the seller reads the rest.

**Sessions:** the cookie is `SameSite=Lax`, so another site cannot send these requests with it. Every query is scoped to the shop in the session, and an import in another shop gets the same `IMPORT_NOT_FOUND` as one that does not exist.

## Seller demo session

This is a minimal demo session, not a production identity system. `POST /api/seller/session` takes a shop slug and that shop's access code and sets a signed, `HttpOnly` cookie that lasts eight hours. `GET` returns the signed-in shop and `DELETE` signs out. People sign in at `/seller/sign-in`.

Naming a shop grants nothing. A seller route must get its shop from `requireSellerShop`, never from request input.
