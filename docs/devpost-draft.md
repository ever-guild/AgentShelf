# Devpost entry draft

Text for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) entry, for [#7](https://github.com/ever-guild/AgentShelf/issues/7). Before every submission, compare "Status" with the deployed build, so the entry claims only what actually works.

Status last compared with the code on 2026-11-06. The early eligibility entry was submitted on 2026-11-05 with an earlier status, so update the entry on Devpost when this section changes.

## Name

AgentShelf

## Elevator pitch

Make any small shop buyable by AI agents. A seller photographs a price list, AI builds the catalog, the buyer's assistant orders, and a human confirms every payment in PayPal.

## About the project

### The problem

Instagram sellers, local stores and repair workshops often have no online store, and building one is out of reach. As people start shopping through assistants such as Claude and ChatGPT, these shops stay invisible: an assistant cannot find their products, check a free repair slot or place an order.

### What we are building

AgentShelf aims to make a small shop buyable by AI agents in about five minutes, with payment through PayPal.

- **Seller:** photograph a price list or upload a CSV. AI extracts products, prices and variants, the seller corrects them in a table and publishes.
- **Buyer:** the buyer's own assistant uses one MCP connector that covers all shops. It finds a product or a free repair slot and creates an order.
- **Payment:** the agent only creates the order and returns a PayPal approval link. The buyer confirms in PayPal, and the money goes directly to the seller.
- **Seller dashboard:** orders, bookings and what agents searched for but did not find, with AI insights on that unmet demand.

### How PayPal and AI fit in

- **PayPal:** Orders v2 with the shop as `payee`, human approval, capture and webhooks, Catalog Products for publishing, and the JavaScript SDK v6 on a simple storefront. Sandbox only.
- **AI:** a vision model turns a price list photo into catalog rows, semantic search matches agent queries across shops, and a seller assistant explains unmet demand.

### Status

This is an early entry, submitted for the eligibility check. Most of the product is now in the code, but it has been tested only against stand-ins. No real PayPal order, payment, webhook or catalog record, no real assistant session and no AG Studio licence key have been exercised yet, so no flow is verified end to end. The [full run guide](full-run.md) lists what is needed.

**Working and tested in the repository:**

- A Postgres data model for shops, products, orders, bookings and demand events. The database itself enforces shop ownership, unique PayPal identifiers, immutable order snapshots and non-overlapping bookings.
- Server-side checkout pricing that takes amounts and the recipient only from stored data, and refuses carts that mix shops.
- A minimal demo seller session and shared, validated service contracts for the MCP tools.
- An MCP server over Streamable HTTP with product search across shops, tested with an MCP client against a local build and, except for finding a product, against the deployed service.
- A checkout service that stores an order, asks PayPal to create it with the shop as recipient and can be retried safely. It returns PayPal's approval link only if the recipient and amount in PayPal's answer match.
- Payment reconciliation: the buyer's return, verified webhooks and a periodic sweep all converge on one service that reads the order from PayPal, captures only what PayPal reports as approved, and marks an order paid only after a verified capture of the stored amount.
- Both of these have been tested against a stand-in for PayPal, not against a real order or payment.
- Catalog import for sellers: sign in, upload a CSV or a photo of a price list, and correct the rows in a table. A missing or unclear price stays unknown and blocks the row until a person fixes it. CSV works end to end up to the reviewed rows. Reading a photo has been tested against a stand-in for the model, not a real one, and publishing reviewed rows to the catalog is built but has not run against PayPal.
- Automated tests against a real Postgres database. All demo data is synthetic.
- Deployment to Render, where every change is published only after lint, tests and a build pass.

**Built, not yet verified against the real service:**

- Publishing to the catalog, search across shops with recorded unmet demand, repair booking with a deposit hold, the storefront with PayPal buttons, the Bryntum schedule, the AG Studio dashboard with demand notes and an assistant, and two seeded demo shops. All are tested with stand-ins or without a licence key.

**Not done:**

- PayPal sandbox credentials and the first real order, deposit and webhook.
- Seeding the deployed service, and connecting it to Claude and ChatGPT, neither of which has been tested.
- A real model run on a price list photo, and the Render workflow service.
- An AG Studio key, the hosted rehearsals and the demo video.

## Built with

**In the code, not yet run against the real service:** Next.js, TypeScript, PostgreSQL, Drizzle ORM, Zod, MCP TypeScript SDK, Claude API, Bryntum Scheduler 8.0 Community and AG Studio without a key. Render hosts the deployed service, and the APIMatic Context Plugin was used while writing PayPal code.

**Written but unverified:** PayPal Orders v2, Catalog Products and the JavaScript SDK v6, with no real order or record yet. **Planned:** PayPal Agent Toolkit, Render Workflows on Render. Add each one to the form only when it is really integrated, including the sponsor tool selection.

## Links

- **Repository:** https://github.com/ever-guild/AgentShelf (public, MIT licence)
- **Hosted demo:** https://agentshelf-e5bk.onrender.com (deployed, with no flow verified against real PayPal yet)
- **Video:** not recorded yet

## Before submitting

Only the team representative can do these, because they need a Devpost login:

1. Check that every teammate has registered for the hackathon, then invite them from the project's team section.
2. Paste the text above and submit.
3. If the form refuses an entry with no video or demo, record that in [#7](https://github.com/ever-guild/AgentShelf/issues/7) as the blocker.
