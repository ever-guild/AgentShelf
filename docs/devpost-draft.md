# Devpost entry draft

Text for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) entry, for [#7](https://github.com/ever-guild/AgentShelf/issues/7). Before every submission, compare "Status" with the deployed build, so the entry claims only what actually works.

Status last compared with the code on 2026-11-05, at commit `ec64d43`.

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

This is an early entry, submitted for the eligibility check. The sections above describe the planned product. No user-facing flow works yet.

**Working and tested in the repository:**

- A Postgres data model for shops, products, orders, bookings and demand events. The database itself enforces shop ownership, unique PayPal identifiers, immutable order snapshots and non-overlapping bookings.
- Server-side checkout pricing that takes amounts and the recipient only from stored data, and refuses carts that mix shops.
- A minimal demo seller session and shared, validated service contracts for the MCP tools.
- Automated tests against a real Postgres database. All demo data is synthetic.

**In progress, not working yet:**

- PayPal: sandbox credentials and merchant routing are being verified. No order has been created yet.
- The MCP server and its connection to Claude and ChatGPT.
- AI catalog extraction, semantic search and insights.
- The Bryntum booking schedule and the AG Studio seller dashboard.
- The storefront, the hosted demo and the demo video.

## Built with

**In the code today:** Next.js, TypeScript, PostgreSQL, Drizzle ORM, Zod.

**Planned:** PayPal Orders v2, PayPal Catalog Products, PayPal Agent Toolkit, PayPal JavaScript SDK v6, MCP TypeScript SDK, AG Studio, Bryntum Scheduler, Render, APIMatic Context Plugin. Add each one to the form only when it is really integrated, including the sponsor tool selection.

## Links

- **Repository:** https://github.com/ever-guild/AgentShelf (public, MIT licence)
- **Hosted demo:** not deployed yet
- **Video:** not recorded yet

## Before submitting

Only the team representative can do these, because they need a Devpost login:

1. Check that every teammate has registered for the hackathon, then invite them from the project's team section.
2. Paste the text above and submit.
3. If the form refuses an entry with no video or demo, record that in [#7](https://github.com/ever-guild/AgentShelf/issues/7) as the blocker.
