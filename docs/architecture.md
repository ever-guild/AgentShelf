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
| `PAYPAL_CLIENT_ID_<REF>`, `PAYPAL_CLIENT_SECRET_<REF>` | app, from [#6](https://github.com/ever-guild/AgentShelf/issues/6) | Sandbox credentials for the shop whose `paypal_credential_ref` is `<REF>`. The client ID also reaches the browser on a shop's product page, as the JS SDK requires, and the secret never does. [#2](https://github.com/ever-guild/AgentShelf/issues/2) may change this once the merchant model is proven |
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
| One product per draft of an import, and never another shop's import | `products_import_job_id_position_unique`, `products_import_job_shop_fk` |
| A product is not `synced` without a PayPal record and a time | `products_synced_requires_record` |
| One technician cannot have overlapping held or confirmed bookings | `bookings_technician_no_overlap` exclusion constraint |
| A booking cannot be `confirmed` without the capture recorded on its own order | `bookings_confirmed_requires_capture`, `bookings_order_capture_fk` |
| A booking in review states why, and the capture is on record | `bookings_review_states_reason`, `bookings_review_requires_capture` |
| A cancelled or failed order keeps no hold, whatever code closed it | `orders_release_hold` trigger |
| One technician's working windows cannot overlap on a weekday, and stay inside one day | `technician_windows_no_overlap`, `technician_windows_within_day` |

Payment state lives on `orders` and booking state on `bookings`. Instants are stored in UTC, and a shop's IANA timezone (`Europe/Riga` for the demo shop) is used for display.

`shops.paypal_credential_ref` names a credential set held in environment variables and is never the credential itself. It and `shops.paypal_merchant_id` stay on the server.

## Service contracts

The Zod schemas in [`src/server/contracts/commerce.ts`](../src/server/contracts/commerce.ts) are the source of truth, shared by HTTP routes and MCP tools. Inputs are strict: a request carrying a total, price, merchant or any other unknown field is rejected, not ignored. Amounts are integer minor units and instants are ISO 8601 with an offset.

| Tool | Input | Result | Implemented in |
| --- | --- | --- | --- |
| `search_products` | `query`, `location?`, `maxPriceMinor?`, `currency?`, `limit?` | `products[]`: `productId`, `shopId`, `shopName`, `location`, `kind`, `title`, `description`, `descriptionLv`, `priceMinor`, `currency`, `availability`, `serviceDurationMinutes`, `depositMinor` | [#5](https://github.com/ever-guild/AgentShelf/issues/5), [#10](https://github.com/ever-guild/AgentShelf/issues/10) |
| `get_slots` | `shopId`, `serviceId`, `from`, `to` | `slots[]`: `slotId`, `technicianId`, `technicianName`, `startsAt`, `endsAt`, `timezone`; `truncated` | [#12](https://github.com/ever-guild/AgentShelf/issues/12) |
| `book_slot` | `slotId`, `serviceId`, `idempotencyKey` | `bookingId`, `orderId`, `expiresAt`, `approvalUrl`, `depositMinor`, `remainingMinor`, `currency`, `statusToken` | [#12](https://github.com/ever-guild/AgentShelf/issues/12) |
| `create_checkout` | `items[]`: `productId`, `quantity`; `idempotencyKey` | `orderId`, `totalMinor`, `currency`, `approvalUrl`, `statusToken` | [#6](https://github.com/ever-guild/AgentShelf/issues/6) |
| `get_order_status` | `orderId`, `statusToken` | `orderId`, `paymentStatus`, `totalMinor`, `currency`, `updatedAt`, and `booking`: `bookingId`, `status`, `reviewReason`, `startsAt`, `endsAt`, `expiresAt`, `timezone`, `depositMinor`, `remainingMinor` | [#11](https://github.com/ever-guild/AgentShelf/issues/11), [#12](https://github.com/ever-guild/AgentShelf/issues/12) |

Services throw a `ServiceError` with a stable code from [`errors.ts`](../src/server/errors.ts). Its message and details are safe to return to a client.

[mcp.md](mcp.md) covers the connector and how to add it to Claude and ChatGPT.

These server pieces already exist for the issues above to build on:

- `createCheckout` is the one checkout entry point for MCP and the [storefront](#storefront). See [Checkout](#checkout).
- `reconcileOrder` is the one place that decides what a PayPal order means for a stored one. See [Payment reconciliation](#payment-reconciliation).
- `createImport` and the review functions around it turn a price list into accepted draft rows. See [Catalog import](#catalog-import).
- `publishImport` and the functions around it turn accepted rows into products and keep their PayPal Catalog records. See [Catalog publication](#catalog-publication).
- `getSlots`, `bookSlot` and `getShopSchedule` are the booking flow and its read model. See [Booking](#booking).
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

**The payment-confirmed hook:** `onPaymentConfirmed` in `ReconcileDeps` runs inside the transaction that marks an order paid, exactly once per order. It confirms a [booking](#booking) there, and does nothing for a purchase. Later notifications can start from it. If it throws, the order stays unpaid here and the next reconciliation tries again, so a hook that cannot fulfil an order, such as a booking whose hold has expired, must record that rather than throw. The money has been captured by then.

**The status read:** `getOrderStatus` follows [paypal-order-status-contract.md](paypal-order-status-contract.md). It reads stored state only, and a missing order and a wrong capability get the same `ORDER_STATUS_UNAVAILABLE`.

## Booking

A buyer's assistant holds a technician's time and the buyer pays a deposit in PayPal, for [#12](https://github.com/ever-guild/AgentShelf/issues/12). [`bookings.ts`](../src/server/services/bookings.ts) holds the writes and [`booking-schedule.ts`](../src/server/services/booking-schedule.ts) the one read.

**Status:** tested with the real SDK against a stand-in for PayPal, on real Postgres, and on a production build. No real deposit has been paid, because the credentials from [#33](https://github.com/ever-guild/AgentShelf/issues/33) do not exist yet. `npm run smoke:booking -- URL --wait` does that once they do.

**The demo's policy** is in [`booking-policy.ts`](../src/server/domain/booking-policy.ts).

| Setting | Value | Why |
| --- | --- | --- |
| Hold lifetime | 15 minutes from `book_slot` | Long enough to open PayPal and approve, short enough that an abandoned hold soon frees the time |
| Deposit | The service's own `deposit_minor`, set by the seller | The rest of the price is paid at the shop. Both are fixed on the booking, so a later price edit changes nothing for it |
| Late payment | The deposit is kept on record, the booking goes to `review_required`, and a person refunds or rebooks | No automatic refund, because a refund is a payment decision for the seller |
| Slot step | 30 minutes from the start of a working window | |
| Lead time | A slot starting within 60 minutes is not offered | Always longer than a hold, so a hold ends before its appointment starts |

**Working time is stored in shop time.** `technician_windows` holds an ISO weekday and minutes from local midnight, and [`shop-time.ts`](../src/server/domain/shop-time.ts) derives UTC per date, so 09:00 stays 09:00 across a clock change. Inside a window everything is elapsed time, so a 60-minute appointment is 60 real minutes. A local time that happens twice means the first time, and one that does not exist moves forward by the size of the gap, which is Temporal's `compatible` rule. In Riga, a window of 02:00 to 06:00 offers 3 hours on the night the clocks go forward and 5 on the night they go back. Any technician can do any service. Working time is set by the seed for now: sellers have no page for it, and a shop with no windows offers no slots.

**A slot ID holds nothing secret and grants nothing.** It names a service, technician, start and duration. `book_slot` checks it against the service and the windows as they are at that moment, with the same function that made the offer, so a made-up ID can only reach a time that `get_slots` would have offered. A slot is listed only while it is free, so being listed is its availability.

**The database decides who gets a slot.** `book_slot` opens one transaction, takes a lock on the technician, marks that technician's stale holds expired, and inserts the order, its line and the hold. It reads no availability first: if the time is taken, `bookings_technician_no_overlap` refuses the insert, the transaction rolls back and the caller gets `SLOT_UNAVAILABLE`. The lock is there because two inserts that see each other can deadlock, and it is not what keeps a slot single. PayPal is called after that commit, by the same [`ensureApprovalLink`](../src/server/services/checkout.ts) as checkout.

**Repeating `book_slot` with a key** answers from what is stored, so it never makes a second booking or a second PayPal order. The key is stored as `booking:<key>`, so it cannot reach an order made through `create_checkout`.

| Booking | Means | Holds the time | How it gets there | A repeat of the key |
| --- | --- | --- | --- | --- |
| `held` | Waiting for the deposit | Yes, until `hold_expires_at` | `book_slot` | Same booking and link |
| `confirmed` | Deposit verified | Yes | A verified capture before `hold_expires_at`, in the transaction that marks the order paid | Same booking and link |
| `expired` | Nobody paid in time | No | The sweep, or the next hold on that technician | `BOOKING_HOLD_ENDED` |
| `cancelled` | The order was cancelled or failed | No | The `orders_release_hold` trigger | `BOOKING_HOLD_ENDED`, or `PAYMENT_DECLINED` if PayPal refused the order |
| `review_required` | The deposit arrived after the hold ended | No | A verified capture at or after `hold_expires_at`, or after a cancel | Same booking and link |

**Time decides expiry, not the sweep.** A hold ends at the exact instant of `hold_expires_at`. Every read treats a hold past that as `expired`, and a capture after it as late, whether or not the row has been marked yet. Marking only matters because the exclusion constraint counts rows still marked `held`, so it happens in the sweep and before every new hold. Slots ask the same clock, so a stale hold's time is offered straight away.

**A late capture never loses money or double-books.** PayPal cannot be told to stop a link it has issued, so a buyer can still approve after a hold ends. The order becomes `paid`, because that is the truth about the money. The booking becomes `review_required` with `deposit_capture_id` and `review_reason` set: `late_capture` after expiry, `captured_after_cancel` after a cancel. A booking in review claims no time, so someone else may already have that slot, or may still take it. The buyer's result page and `get_order_status` say the appointment is not confirmed. The seller has to refund or rebook, and the schedule keeps showing it until a seller tool exists for that, which is outside this issue. A hold whose order goes to `review_required` for another reason just runs out, and the order's own state says a person has to look.

**Errors:** beyond the ones listed under [Checkout](#checkout):

| Code | When | What the caller does |
| --- | --- | --- |
| `SLOT_UNAVAILABLE` | The time is taken, or the slot is no longer one the service and windows offer | Calls `get_slots` again |
| `BOOKING_HOLD_ENDED` | A repeat of a key whose hold has expired or been cancelled | Calls `get_slots` again and uses a new key |
| `PRODUCT_NOT_FOUND` | No published service with this ID, or it belongs to another shop | Searches again |

**The read model:** `getShopSchedule(db, shopId, from, to, now?)` is what the scheduler and the dashboard read, and `getOrderBooking(db, orderId, now?)` gives `get_order_status` the same view of one booking. The caller must already know the shop is theirs, so a seller route takes `shopId` from the session. It returns technicians with their weekly windows, and every booking touching the range, in every state:

```ts
{
  shopId, timezone, currency, from, to,
  technicians: [{ technicianId, name, windows: [{ weekday, startMinute, endMinute }] }],
  bookings: [{
    bookingId, orderId, status, reviewReason, blocksTime,
    serviceId, serviceTitle, technicianId, technicianName,
    startsAt, endsAt, holdExpiresAt, timezone,
    paymentStatus, priceMinor, depositMinor, remainingMinor, currency,
    depositCaptureId, updatedAt,
  }],
}
```

A view of what occupies the calendar filters on `blocksTime`. `depositCaptureId` is for the seller, and `get_order_status` leaves it out. A booking confirmed and later refunded at PayPal stays `confirmed` with `paymentStatus: "review_required"`, so a view should show both.

**Known limit:** the connector has no sign-in, so an assistant can hold free slots with new keys, each for 15 minutes, and each creates a PayPal order. Nothing limits that yet.

## Storefront

The public shop link at `/shops/<slug>`, for [#16](https://github.com/ever-guild/AgentShelf/issues/16). It lists a shop's published products with title, description, price and availability, and sells one product at a time. A sandbox notice is on every page.

**Status:** the pages, the order path and every result state have run on a production build, with the real server SDK against a stand-in for PayPal and a stand-in for the browser SDK. No real purchase has gone through it, and the real `<paypal-button>` has not been clicked, because the credentials from [#33](https://github.com/ever-guild/AgentShelf/issues/33) do not exist yet.

**The browser:** [PayPal's JavaScript SDK v6](https://developer.paypal.com/sdk/js/set-up.md), from `https://www.sandbox.paypal.com/web-sdk/v6/core`, started with the shop's client ID. That is the documented choice for one-time payments, and the client ID is public by design. A shop's app creates its orders, so the same app's client ID approves them, and the SDK needs no merchant ID. The `merchantId` in the order is set on the server only.

**The order:** `POST /api/shops/<slug>/checkout` takes only `productId` and a UUID `idempotencyKey`, and always buys one item. Anything else in the request, such as a price, a total, a merchant or a quantity, is refused. It calls [`createCheckout`](#checkout), so totals, recipient and the rules for what can be sold are the same as for MCP. A product of another shop gets the same `PRODUCT_NOT_FOUND` as one that does not exist. The key is stored as `storefront:<uuid>`, so a browser cannot reach an order made through MCP by reusing its key.

**The way back:** approving in PayPal sends the browser to `/checkout/return`, and cancelling to `/checkout/cancel`, the same routes as an approval link. They [reconcile](#payment-reconciliation) and redirect to `/checkout/result`, so success appears only after the server has read a completed capture from PayPal. A delayed capture shows as still confirming, with a link that asks PayPal again. The result page names the shop and links back to it.

**When the SDK cannot be used:** if it does not load, is not eligible for this buyer or fails, the page offers a button to the order's approval link, on PayPal's own page. That path does not need the SDK, and a person still approves in PayPal.

**With no payment set up:** a shop with no merchant or no credentials still lists its products, says that payment is not set up, and loads no PayPal script.

**Services** are not sold here. Their rows and pages point to booking through an assistant, because [booking](#booking) has one flow.

**Descriptions:** `chooseDescription` shows the seller's reviewed English or Latvian text, then the source's own words, and translates nothing itself. It reads `description_en` and `description_lv` on `products`, which [publication](#catalog-publication) fills. A shop with no reviewed Latvian shows `description` and offers no language choice. Titles are not translated.

**What a page can see:** [`storefront.ts`](../src/server/services/storefront.ts) returns explicit fields, so a new column stays private until someone adds it. A page never receives a merchant ID, a credential reference, a PayPal product ID or a draft.

**A missing shop or product** shows a not-found page with `noindex`, but its HTTP status is `200`, because the page has already started streaming by then.

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

## Catalog publication

The accepted rows of a finished review become products, for [#9](https://github.com/ever-guild/AgentShelf/issues/9). [`seller-catalog.ts`](../src/server/services/seller-catalog.ts) holds the rules, [`paypal/catalog.ts`](../src/server/paypal/catalog.ts) the PayPal calls, and sellers work at `/seller/catalog`.

**Status:** tested with the real SDK against a stand-in for PayPal, which follows PayPal's published schema. No real Catalog record has been created, because the credentials from [#33](https://github.com/ever-guild/AgentShelf/issues/33) do not exist yet. That the sandbox accepts an ID chosen by the caller, and refuses a repeat with `DUPLICATE_RESOURCE_IDENTIFIER`, comes from the documentation and has not been seen.

**The rule for what buyers can find:** a product is discoverable once its status is `published`, and only then. Search, the public catalog, checkout and the storefront all read that one column, and it does not depend on PayPal Catalog. Orders v2 does not need a Catalog record, so a failure there never stops a sale. `get_slots` and `book_slot` hold to the same rule.

**A Catalog record is not a listing.** It holds a name, a description and a type. Creating one does not prove or cause listing in Store Sync, Agent Ready or any other shopping search, and nothing here claims so. Price, stock, variants and duration stay local, because a record has nowhere to put them.

**Publishing** is one transaction holding the import's job. Each accepted row is checked again against the shop's current settings, because they can change after a review. Rows that pass become products and their drafts are deleted, along with the removed rows. A row that no longer passes stays as a draft showing what is wrong, and the seller puts it in a new upload, since a review does not reopen.

A repeat, at the same time or later, finds nothing left to do. `products_import_job_id_position_unique` stops a second product from the same draft whatever code writes it. A second upload of the same list is new work, not a retry, so it does make new products, and the seller unpublishes what they do not want.

**Text:** `products.description` holds the English the seller chose, or the source's words if they chose none, and it is what search and assistants read. `description_en` and `description_lv` are set only when a seller reviewed that language, so the storefront knows which language it is showing. Search also covers the Latvian, and `ProductSummary` returns it. The source's words are not kept once English replaces them.

**One PayPal record per product.** `paypal_sync_status` is per product, and sending happens after publishing has committed.

| State | Means | Way out |
| --- | --- | --- |
| `pending` | Waiting to be sent, including rows from before this existed | `/seller/catalog` sends it when opened |
| `synced` | PayPal holds the record named in `paypal_product_id`, as of `paypal_synced_at` | Stays. It is never sent again |
| `failed` | PayPal refused or did not answer. `paypal_sync_error` holds a short code, and the seller sees what to do | **Try again** on the row, or send them all |
| `not_configured` | The shop has no credentials on this server | The same, once they exist |

Two things are fixed per product, so no number of retries can make a second record. `PayPal-Request-Id` is the product's ID, and a repeat within PayPal's 72 hours returns the first answer. The record's own ID is `AS-<product ID>`, chosen here, so a repeat after that is refused as a duplicate, and the record that names is read and adopted. An answer naming any other ID is not stored.

A batch is 10 products, and the page asks for one after another, so a closed tab loses nothing. A timeout, an unknown failure or refused credentials ends the batch, since the next request would only repeat them. A refusal of one record does not. Unpublished products are not sent.

**Edits and unpublishing:** a seller can change a price and a service's deposit, unpublish and publish again. None of these call PayPal, because a record holds no price and PayPal has no delete. An unpublished product's record stays at PayPal, and renaming would not reach it either, because PayPal cannot change a record's name. The next checkout reads the new price or refuses the product. An existing order keeps the amounts it was created with, and an approval link already issued can still be paid at that amount.

**Search:** `onCatalogChange` in `CatalogDeps` runs inside the transaction of every publish, edit and unpublish, with the product IDs and the kind of change. It does nothing yet, and it is the one place [#10](https://github.com/ever-guild/AgentShelf/issues/10) needs to index from. If it throws, the change does not happen, so slow work belongs in a queue it writes to.

## Seller demo session

This is a minimal demo session, not a production identity system. `POST /api/seller/session` takes a shop slug and that shop's access code and sets a signed, `HttpOnly` cookie that lasts eight hours. `GET` returns the signed-in shop and `DELETE` signs out. People sign in at `/seller/sign-in`.

Naming a shop grants nothing. A seller route must get its shop from `requireSellerShop`, never from request input.
