# Devpost entry draft

Copy-ready text for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) entry, for [#22](https://github.com/ever-guild/AgentShelf/issues/22). Each section below can be pasted into the matching Devpost field. The Devpost form needs a login and its exact fields were not seen, so the representative maps these sections to the form.

Last checked against `main` 198bc1f and the live service on 2026-11-10. Rules read on 2026-11-10: [rules](https://paypalaihackathon.devpost.com/rules). Deadline: Nov 12, 2026 12:00 pm PST (20:00 UTC). The internal team target may be earlier.

## Name

AgentShelf

## Elevator pitch

AgentShelf lets a small shop publish a price list as an AI-readable catalog, so a buyer's AI assistant can find items and repair slots over MCP, while a human approves every payment in PayPal Sandbox.

## About the project

### Inspiration and problem

Instagram sellers, local stores and repair workshops often have no online store, and building one is hard for them. As people start to shop through AI assistants, these shops stay invisible: an assistant cannot find their products, check a free repair slot or start an order.

### What it does

- **Seller:** photograph a price list or upload a CSV. AI reads the rows (photos only; CSV parsing is deterministic), the seller reviews and corrects them in a table, then publishes.
- **Buyer:** the buyer's assistant connects to one MCP endpoint that covers all shops. It can search products, list free repair slots, book a slot with a deposit, and create a checkout.
- **Payment:** the tools only return a PayPal approval link. A human approves the payment in PayPal Sandbox, and the server captures it after approval.
- **Dashboard:** the seller sees orders, bookings, searches that found nothing (unmet demand) and AI notes on that demand, in AG Studio. Repair bookings appear in a Bryntum Scheduler.
- **Seller agent:** an owner can also grant a shop-scoped token so their own agent (verified with Claude Code) can import a price list, publish and manage stock.

### How we built it

A Next.js and TypeScript app with PostgreSQL, deployed on Render. The MCP endpoint uses the MCP TypeScript SDK over Streamable HTTP. Search is deterministic: an AI model writes search terms for each listing in English, Latvian and Russian once at indexing time, and queries are then matched in Postgres full-text search without a model call. Stock is reserved at checkout and decremented after a verified capture.

### How PayPal is used

- **Orders v2:** `create_checkout` and `book_slot` create a Sandbox order whose payee is the seller. The target path is a Platform REST app with each seller's consent through Partner Referrals. The server captures only after the buyer approved.
- **Webhooks:** events are signature-verified and stored. One chain was received and verified on 8 Nov (`CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`).
- **Log in with PayPal** for owner sign-in, and the PayPal JavaScript SDK v6 for the storefront buttons (implemented, not yet confirmed by a human buyer, see the table).
- Sandbox only. The PayPal Agent Toolkit is not used.

### How AI is used

- **In the product:** the live service uses an OpenAI-compatible provider with model `gpt-6-astra` for price-list photo reading, listing descriptions, search terms and unmet-demand notes. A Claude adapter also exists and is used when only an Anthropic key is configured. The AG Studio assistant reads the demand data.
- **As the buyer:** in a closing check on 9 Nov, Claude Code with claude-opus-5-5 acted as a buyer over the public MCP endpoint (see the table).
- **While building:** AI coding agents and the APIMatic Context Plugin skills for PayPal SDK code.

### Challenges

Routing money to the right seller needs platform credentials, seller consent and care that nothing is captured before a person approves. Stock, a 15-minute slot hold and the PayPal order must stay consistent. One of two test sellers could not finish consent (PayPal UserInfo HTTP 401).

### Accomplishments

A person approved Sandbox payments that were captured for a connected seller, through a Claude Code buyer on the public MCP endpoint (9 Nov), with stock decremented and a repair deposit confirmed in rehearsals. Photo import ran with a real model on Render.

### What we learned

Fail-closed defaults (no stock decision, no payment connection) are easier to trust than silent fallbacks. A claim about a client or integration should be tested with that client, so some items below are listed as not run.

### What's next

Test the claude.ai and ChatGPT connectors, confirm the storefront buttons with a human buyer, resolve PayPal Catalog sync for platform shops, and decide on hosting continuity.

## Significant update during the submission period

The repository's first commit is dated 2026-11-05, so the work was started within the submission period, which began Oct 1, 2026. Everything described here, including the PayPal integration, MCP endpoints, seller onboarding, dashboard and hosted deployment, was built and verified during that period; see the commit history and the [CHANGELOG](../CHANGELOG.md).

## Built with

TypeScript, Next.js 16, React, PostgreSQL (Drizzle migrations), MCP TypeScript SDK (Streamable HTTP), `@paypal/paypal-server-sdk`, PayPal Orders v2, Partner Referrals, webhooks, Log in with PayPal, PayPal JS SDK v6, an OpenAI-compatible model (`gpt-6-astra`) and Anthropic Claude (adapter), Render (web service and managed PostgreSQL), `@renderinc/sdk`, GitHub Actions.

### Sponsor tools used

- **Render:** hosts the web service and PostgreSQL; CI deploys the exact commit. Render Workflows code exists, see the table for its limit.
- **Bryntum Scheduler** (8.0 Community): repair bookings.
- **AG Grid's AG Studio:** the seller dashboard and assistant. It runs in trial mode without a licence key on the live service.
- **APIMatic Context Plugin:** used while writing PayPal Server SDK client code ([docs/integrations.md](integrations.md)). A claim form has not been filed.
- **Postman:** a smoke collection exists in [docs/postman](postman/README.md); it has not been run, so select Postman only if the team runs it first.

### Not used or not claimed

PayPal Agent Toolkit, Elastic, Zapier, KERNEL, Astropods, Channel3.

## Links

- Repository: https://github.com/ever-guild/AgentShelf (public, MIT, verified 2026-11-10)
- Hosted demo: https://agentshelf-e5bk.onrender.com
- MCP URL: https://agentshelf-e5bk.onrender.com/mcp
- Setup instructions: [README](../README.md) and [DEVELOP.md](../DEVELOP.md)
- Video: pending ppmarkek / #21

## Testing instructions for judges

1. Open the hosted demo and the [README](../README.md) walkthrough. Health check: `/api/health` returns the deployed commit.
2. Connect an MCP client to `https://agentshelf-e5bk.onrender.com/mcp` with no authentication, following [docs/mcp.md](mcp.md). Claude Code is the verified client. Try "find an iPhone 13 screen protector in Liepaja".
3. Payments are PayPal Sandbox only. To approve a payment, use a Sandbox buyer account. The Sandbox buyer credentials are supplied by the representative in the private testing field of the Devpost form and are not in this repository.
4. Seller side: register an owner at `/seller/register` or sign in with PayPal, then import a CSV at `/seller/imports`.

## Claim and evidence

| Claim | Evidence | Status / limit |
| --- | --- | --- |
| Hosted service live on 198bc1f | `/api/health` and `/api/health/ready` returned HTTP 200 and the same commit, 2026-11-10 | PASS 2026-11-10, 198bc1f. Re-check before submitting |
| Buyer MCP read tools | `tools/list` returned 5 tools; `search_products` found 2 products in `full` mode; `get_slots` returned 68 slots, 2026-11-10 ([docs/mcp.md](mcp.md)) | PASS 2026-11-10, 198bc1f. No order created |
| Real external client buyer run | [Closing checks](https://github.com/ever-guild/AgentShelf/issues/18#issuecomment-6751202970): Claude Code 2.1.282 with claude-opus-5-5 searched and created a checkout, 9 Nov | PASS 2026-11-09. Claude Code only (a CLI) |
| Human-approved Sandbox payment and capture | Same comment: 9.90 EUR approved by a person, order `paid`; also [rehearsals](https://github.com/ever-guild/AgentShelf/issues/18#issuecomment-6751024359) | PASS 2026-11-09 on d908114 |
| Booking deposit | Rehearsals 2 and 3: 20 EUR deposit approved and captured ([comment](https://github.com/ever-guild/AgentShelf/issues/18#issuecomment-6751024359)) | PASS 2026-11-09 on d908114 |
| Stock decrement | Same rehearsals: stock 4 to 3 to 2; closing check 2 to 1 | PASS 2026-11-09 |
| Webhook receipt | [docs/paypal-sandbox-proof.md](paypal-sandbox-proof.md): approved and capture-completed events received and verified for one EUR 1 order, 8 Nov | PASS 2026-11-08, one event chain. LIMIT: not proven for the 9 Nov captures |
| Photo import by a real model on Render | [Issue 48 acceptance](https://github.com/ever-guild/AgentShelf/issues/48#issuecomment-6749978975): provider `openai`, model `gpt-6-astra`, two synthetic price-list photos read correctly, 9 Nov, 6bdf36b | PASS 2026-11-09. Read in the web process |
| Demand insights | Rehearsals and issue 48 comment: unmet-demand notes written by `gpt-6-astra` | PASS 2026-11-09 |
| Seller MCP | [README](../README.md) states Claude Code CLI 2.1.319 verified the seller MCP; see [seller-agent-rehearsal.md](seller-agent-rehearsal.md) | PASS with Claude Code only. Date and commit not restated here; check the doc |
| Render Workflows | Code and CI delivery on main ([render-workflows.md](render-workflows.md)) | LIMIT: no hosted workflow and no hosted photo run verified |
| claude.ai connector | Steps in [docs/mcp.md](mcp.md) | NOT_RUN |
| ChatGPT connector | Steps in [docs/mcp.md](mcp.md) | NOT_RUN |
| Storefront JS SDK v6 buttons | Implemented in `src/app/shops/buy-flow.ts` | NOT_RUN with a human Sandbox buyer |
| PayPal Catalog for platform shops | Products in the rehearsal shop show `not_configured` | OPEN. Cause unconfirmed; PayPal permission not verified |
| Hosting through judging | [#56](https://github.com/ever-guild/AgentShelf/issues/56): free database expires 2026-12-05 19:08 UTC, judging runs 1 to 15 Dec | OPEN. Owner decision pending |
| Demo video | [#21](https://github.com/ever-guild/AgentShelf/issues/21), final cut 02:18.410 | OPEN. No public link known. Animated scenes are not evidence of a real client run |

## Not ready or not confirmed

- Video link (#21), claude.ai and ChatGPT connectors, storefront buttons with a human buyer, Catalog sync, Render Workflows hosted run, hosting after 2026-12-05 (#56).
- Webhook deliveries for the 9 Nov captures; a second connected seller.
- Devpost form fields and any sponsor-specific form questions.

## Representative checklist

- [ ] Log in to Devpost and confirm teammates.
- [ ] Paste each section above into the matching field.
- [ ] Select only sponsor tools with evidence above.
- [ ] Add the YouTube link once #21 publishes it, and confirm it is public and under 3 minutes.
- [ ] Add Sandbox test buyer details only in the form's private testing field.
- [ ] Confirm the #56 hosting decision.
- [ ] Re-run `/api/health` and compare the commit with the table.
- [ ] Save the draft and submit before Nov 12, 2026 12:00 pm PST (20:00 UTC).
