# Devpost entry draft

Copy-ready text for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) entry, for [#22](https://github.com/ever-guild/AgentShelf/issues/22). Each section below can be pasted into the matching Devpost field. The Devpost form needs a login and its exact fields were not seen, so the representative maps these sections to the form.

Last checked against `main` and Render live at `eb41627` on 2026-11-10: `/`, `/api/health` and `/api/health/ready` returned HTTP 200 and health reported that commit. [CI run 42784931543](https://github.com/ever-guild/AgentShelf/actions/runs/42784931543) passed lint, the full suite, production build and deploy on the same commit; the local run on it counted 1,866 tests ([#19](https://github.com/ever-guild/AgentShelf/issues/19)). The hosted checks in the table below remain dated to their actual revisions. Rules read on 2026-11-10: [rules](https://paypalaihackathon.devpost.com/rules). Deadline: Nov 12, 2026 12:00 pm PST (20:00 UTC). The internal team target may be earlier.

The paste-ready sections are written for the five judging criteria (Technological Implementation, Design, Potential Impact, Innovation/Idea, Presentation). Judges are not required to run the project, so the text leads with the problem and the demonstrated result, and keeps the open checks to one short paragraph that links to the full matrix. Links inside the paste-ready sections are absolute, because relative links do not resolve on Devpost.

## Name

AgentShelf

## Elevator pitch

A shop photographs its price list. Minutes later a buyer's AI assistant can find its products, book a repair slot and start a PayPal checkout that a person approves.

## About the project

### Inspiration

A phone repair workshop has a paper price list on the wall and an Instagram page. It has no online store and no time to build one. When someone asks their assistant "who can replace an iPhone 13 screen tomorrow, and what does it cost?", that workshop does not exist for the assistant. It cannot be searched, its free slots cannot be read, and an order cannot be started.

Shopping is moving into assistants, and the shops with the least time for technology are the first to be left out. We wanted the smallest possible step for them: a photo of the price list they already have.

### What it does

**For the shop**

- Photograph a price list or upload a CSV. AI reads the photo into rows, the seller corrects them in a table and publishes. Nothing is guessed: a price written as "from 60 €" or "on request" stays empty for the seller to fill in.
- Connect a PayPal account once. Every order names the shop as the payee, so the money goes directly to the seller.
- See orders, repair bookings and stock in one dashboard, and see **what assistants searched for and did not find**. A workshop that sells screen protectors learns that buyers asked for wireless chargers and leather cases, with AI notes on each group of searches.

**For the buyer**

- One MCP connector covers every shop. The buyer's own assistant searches products and services, reads free technician slots, holds a slot and creates a checkout.
- The assistant never pays. It returns a PayPal approval link, a person approves the payment in PayPal, and only then does the server capture it.

**Demonstrated on the hosted service, in PayPal Sandbox**

- An assistant found a tempered glass for iPhone 13 and created a 9.90 EUR order. A person approved it in PayPal, the server captured it, and tracked stock went from 4 to 3.
- An assistant booked a screen repair with a 20 EUR deposit. After approval the booking appeared in the workshop's schedule as confirmed: "Deposit of 20.00 EUR paid, 69.00 EUR due at the shop".
- Three rehearsals on one deployed commit, with no reset between them, produced six captures.

### How we built it

Next.js 16, TypeScript and PostgreSQL on Render. CI runs lint, more than 1,800 tests and the production build, then deploys the exact commit.

**PayPal**

- **Orders v2** with the seller as `payee`. The tools create the order and return the approval link; capture happens only after PayPal reports the buyer's approval.
- **Partner Referrals** for seller consent, with two separate Sandbox merchants connected.
- **Webhooks**, signature-verified and reconciled with orders, slot holds and stock.
- **Log in with PayPal** for shop owners, and **JS SDK v6** buttons on the public storefront.

**AI**

- A vision model reads price-list photos into rows and marks what it is unsure about. A note planted in a test photo asking it to change every price was ignored.
- When a listing is published, the model writes its description in English and Latvian and its search terms in English, Latvian and Russian. Buyer search is then PostgreSQL full-text search with no model call per query, so it is fast and repeatable, and a Russian or Latvian query still finds the listing.
- The model groups and explains unmet searches, and answers the seller's questions about them in the dashboard.

**MCP**

One buyer endpoint over Streamable HTTP with five tools: `search_products`, `get_slots`, `book_slot`, `create_checkout`, `get_order_status`. A separate seller endpoint lets the owner's own agent manage the catalog and stock under a shop-scoped grant the owner can revoke.

**Partner tools**

- **AG Grid (AG Studio):** the seller dashboard, with a custom theme, custom widgets for payments, upcoming bookings and unmet demand, and an assistant on the Studio Agent Framework that can read only its own shop's data.
- **Bryntum Scheduler:** technicians are resources and bookings are events. A slot held by an assistant and paid by a person appears in the timeline with its deposit status.
- **APIMatic Context Plugin:** used while writing the PayPal Server SDK code. It led to an explicit request timeout, idempotent retries and error handling by status code and `debug_id`.
- **Channel3:** a seller can check market specs and reference prices for a product, and applies a price explicitly.
- **Render:** Web Service and managed PostgreSQL.
- **Postman:** a smoke collection run with Newman.

### Challenges we ran into

- **Stock, a slot hold and a PayPal order must agree.** A slot is held for 15 minutes while the buyer approves. Stock is reserved at checkout and decremented once, after a verified capture. Tests cover the last unit bought twice and a cancel racing a capture.
- **A price list is messy.** The model leaves unclear values empty, because a wrong published price is worse than a blank the seller fills in.

### Accomplishments that we're proud of

- The whole path works on a public URL: price list, catalog, assistant search, human-approved PayPal payment, capture, stock and schedule update, dashboard.
- Services are sold as well as products: a technician slot with a PayPal deposit.
- Sellers get a signal ordinary stores do not have: the demand that assistants could not satisfy.

### What we learned

- Fail-closed defaults are easier to trust than silent fallbacks. A product with no stock decision cannot be bought, and a shop with no PayPal connection cannot take an order.
- One working MCP client does not prove another works, so we record which client ran which flow.

### What's next for AgentShelf

Record full purchase runs in the claude.ai and ChatGPT connectors, move photo reading to a background Render Workflow, sync published items to the PayPal catalog, and then try AgentShelf with real workshops.

### Verified scope

PayPal Sandbox only, no real money. The assistant client verified end to end is Claude Code. The same public endpoint has setup guides for claude.ai and ChatGPT; full purchase runs in those two clients, and a human purchase through the storefront buttons, are not recorded yet. The [capability matrix](https://github.com/ever-guild/AgentShelf/blob/main/docs/capabilities.md) lists every capability with its evidence level, date and commit.

## Significant update during the submission period

The repository's first commit is dated 2026-11-05, so the work was started within the submission period, which began Oct 1, 2026. Everything described here, including the PayPal integration, MCP endpoints, seller onboarding, dashboard and hosted deployment, was built during that period; see the commit history and the [CHANGELOG](../CHANGELOG.md).

## Built with

Tags for the Devpost field: `typescript`, `next.js`, `react`, `postgresql`, `mcp`, `paypal`, `gpt`, `claude`, `render`, `ag-grid`, `bryntum`, `channel3`, `apimatic`, `postman`, `github-actions`.

Remove the `paypal-agent-toolkit` tag from the live entry. The toolkit is not used.

In full: TypeScript, Next.js 16, React, PostgreSQL (Drizzle migrations), MCP TypeScript SDK (Streamable HTTP), `@paypal/paypal-server-sdk`, PayPal Orders v2, Partner Referrals, webhooks, Log in with PayPal, PayPal JS SDK v6, an OpenAI-compatible model (`gpt-6-astra`) and Anthropic Claude (adapter), Render (web service and managed PostgreSQL), `@renderinc/sdk`, GitHub Actions.

### Tools and how they were used

The form asks which model or AI service was used and how.

- **In the product:** the live service uses an OpenAI-compatible provider with model `gpt-6-astra` for price-list photo reading, listing descriptions, search terms, unmet-demand notes and the dashboard assistant. An Anthropic Claude adapter also exists and is used when only an Anthropic key is configured.
- **As the buyer and the seller agent:** Claude Code acted as a buyer over the public MCP endpoint on 9 Nov and as a seller agent on 8 Nov (see the table).
- **While building:** AI coding agents and the APIMatic Context Plugin skills for PayPal Server SDK code.

### Sponsor tools and their evidence

- **Render:** hosts the web service and PostgreSQL; CI deploys the exact commit. Render Workflows code exists, see the table for its limit.
- **Bryntum Scheduler** (8.0 Community): repair bookings, [`schedule-timeline.tsx`](../src/app/seller/schedule/schedule-timeline.tsx).
- **AG Grid's AG Studio:** the seller dashboard and assistant. The team accepted an AG Studio Pro with AI licence through 24 December 2026; see [integration evidence](integrations.md#ag-studio).
- **Channel3:** helps a seller review suggested product specs and reference prices, then explicitly apply a selected price to a catalog item ([channel3.md](channel3.md)).
- **APIMatic Context Plugin:** used while writing PayPal Server SDK client code ([integrations.md](integrations.md#apimatic-context-plugin)). The APIMatic claim form is a separate step and has not been filed.
- **Postman:** the smoke collection in [docs/postman](postman/README.md) was verified with Newman: 10 requests and 20 assertions passed ([#20](https://github.com/ever-guild/AgentShelf/issues/20)).

### Not used or not claimed

PayPal Agent Toolkit, Elastic, Zapier, KERNEL, Astropods.

## Links

- Repository: https://github.com/ever-guild/AgentShelf (public, MIT, verified 2026-11-10)
- Hosted demo: https://agentshelf-e5bk.onrender.com
- MCP URL: https://agentshelf-e5bk.onrender.com/mcp
- Setup instructions: [README](../README.md) and [DEVELOP.md](../DEVELOP.md)
- Video: https://www.youtube.com/watch?v=wm-96MgGBOY (public, 2:18; remaining checks in [#21](https://github.com/ever-guild/AgentShelf/issues/21))

## Testing instructions for judges

1. Open the hosted demo and the [README](../README.md) walkthrough. Health check: `/api/health` returns the deployed commit.
2. Connect an MCP client to `https://agentshelf-e5bk.onrender.com/mcp` with no authentication, following [docs/mcp.md](mcp.md). Claude Code is the verified client. Try "find an iPhone 13 screen protector in Liepaja".
3. Payments are PayPal Sandbox only. To approve a payment, use a Sandbox buyer account. The Sandbox buyer credentials are supplied by the representative in the private testing field of the Devpost form and are not in this repository.
4. Seller side: register an owner at `/seller/register` or sign in with PayPal, then import a CSV at `/seller/imports`.

## Claim and evidence

| Claim | Evidence | Status / limit |
| --- | --- | --- |
| Hosted service read-only check | `/api/health` and `/api/health/ready` returned HTTP 200 and the same commit, 2026-11-10 | PASS 2026-11-10 on `198bc1f` at 03:51-03:52 UTC and again on `eb41627`. Re-check before submitting |
| Buyer MCP read tools | `tools/list` returned 5 tools; `search_products` found 2 products in `full` mode; `get_slots` returned 68 slots, 2026-11-10 ([docs/mcp.md](mcp.md)) | PASS 2026-11-10, 198bc1f. No order created |
| Real external client buyer run | [Closing checks](https://github.com/ever-guild/AgentShelf/issues/18#issuecomment-6751202970): Claude Code 2.1.282 with claude-opus-5-5 searched and created a checkout, 9 Nov | PASS 2026-11-09. Claude Code only (a CLI) |
| Human-approved Sandbox payment and capture | Same comment: 9.90 EUR approved by a person, order `paid`; also [rehearsals](https://github.com/ever-guild/AgentShelf/issues/18#issuecomment-6751024359) | PASS 2026-11-09 on d908114 |
| Booking deposit and schedule | Rehearsals 2 and 3: 20 EUR deposit approved and captured; `/seller/schedule` showed three confirmed bookings with "Deposit of 20.00 EUR paid, 69.00 EUR due at the shop" ([comment](https://github.com/ever-guild/AgentShelf/issues/18#issuecomment-6751024359)) | PASS 2026-11-09 on d908114 |
| Stock decrement | Same rehearsals: stock 4 to 3 to 2; closing check 2 to 1 | PASS 2026-11-09 |
| Webhook receipt | [docs/paypal-sandbox-proof.md](paypal-sandbox-proof.md): approved and capture-completed events received and verified for one EUR 1 order, 8 Nov | PASS 2026-11-08, one event chain. LIMIT: not proven for the 9 Nov captures |
| Photo import by a real model on Render | [Issue 48 acceptance](https://github.com/ever-guild/AgentShelf/issues/48#issuecomment-6749978975): provider `openai`, model `gpt-6-astra`, two synthetic price-list photos read correctly, unclear prices left empty and a planted instruction ignored, 9 Nov, 6bdf36b | PASS 2026-11-09. Read in the web process |
| Search terms in three languages | Same comment: published rows found by Latvian and Russian queries such as `ekrāna nomaiņa` and `замена экрана` | PASS 2026-11-09, terms written by `gpt-6-astra`. Older demo-shop terms do not match Cyrillic `айфон` |
| Demand insights and dashboard assistant | Rehearsals and issue 48 comment: unmet-demand notes written by `gpt-6-astra`; the AG Studio assistant read the shop's demand groups and refused a cross-shop and refund request | PASS 2026-11-09 |
| Seller MCP | [Claude Code session](seller-agent-rehearsal.md#external-claude-code-session): Claude Code 2.1.319 created a shop, imported, reviewed and published a price list and set stock, deployed demo `0c8e262`, 8 Nov | PASS 2026-11-08. Claude Code only; no PayPal step in that run |
| Two connected Sandbox merchants | [#35](https://github.com/ever-guild/AgentShelf/issues/35) and the [capability matrix](capabilities.md): two distinct Sandbox merchants connected through Partner Referrals | PASS, Sandbox only |
| Render Workflows | Code and CI delivery on main ([render-workflows.md](render-workflows.md)); hosted activation remains gated by [#55](https://github.com/ever-guild/AgentShelf/issues/55) and hosting continuity by [#56](https://github.com/ever-guild/AgentShelf/issues/56) | LIMIT: hosted service is not enabled for Workflows; no hosted workflow or photo run verified |
| Channel3 catalog enrichment | Real provider API and local browser price lookup verified at `5348463`; issue [#24](https://github.com/ever-guild/AgentShelf/issues/24#issuecomment-6759013324) closed. On `11f634e`, SSR checked selected-attribute rendering, full CI [42755300614](https://github.com/ever-guild/AgentShelf/actions/runs/42755300614) passed 1,845 tests/build/deploy, and live health matched the SHA | PASS for the cited API/browser run and final CI/live checks; a final-revision browser interaction remains inconclusive |
| claude.ai connector | Steps in [docs/mcp.md](mcp.md) | NOT_RUN |
| ChatGPT connector | Steps in [docs/mcp.md](mcp.md) | NOT_RUN |
| Storefront JS SDK v6 buttons | Implemented in `src/app/shops/buy-flow.ts` | NOT_RUN with a human Sandbox buyer |
| PayPal Catalog for platform shops | [Release handoff](https://github.com/ever-guild/AgentShelf/issues/19#issuecomment-6751195724): products published in the PayPal-connected rehearsal shop show sync `not_configured`, 9 Nov | OPEN. Cause unconfirmed; PayPal permission for Catalog calls not verified. Listings stay on sale |
| Hosting through judging | [#56](https://github.com/ever-guild/AgentShelf/issues/56): free database expires 2026-12-05 19:08 UTC, judging runs 1 to 15 Dec | OPEN. Owner decision pending |
| Demo video | https://www.youtube.com/watch?v=wm-96MgGBOY: a signed-out request on 2026-11-10 returned the video as public (not private, not unlisted), 138 to 139 s long, published 2026-11-09 | PASS for public visibility and length under 3 minutes. OPEN in [#21](https://github.com/ever-guild/AgentShelf/issues/21): captions, permissions, sensitive-data and content checks. Animated scenes are not evidence of a real client run |

## Before pasting

- Fix the first gallery caption on the live entry: "eview imported CSV products" should read "Review imported CSV products".
- Remove the "Current limits" section from the live entry; "Verified scope" above replaces it.
- If a full purchase is recorded in claude.ai or ChatGPT, or through the storefront buttons, before submission: add it to [capabilities.md](capabilities.md) with client, date and commit first, then update "Verified scope", "What's next" and the table rows above. Do not edit the entry ahead of the evidence.

## Not ready or not confirmed

- claude.ai and ChatGPT connectors, storefront buttons with a human buyer, Catalog sync, Render Workflows hosted run, hosting after 2026-12-05 (#56).
- Video: the remaining #21 checks (captions, permissions, sensitive data, content against the delivered candidate).
- Webhook delivery receipts for the 9 Nov captures remain unread.
- The APIMatic claim form ([integrations.md](integrations.md#owner-actions)) has not been filed.
- Devpost form fields and any sponsor-specific form questions.

## Representative checklist

- [ ] Log in to Devpost and confirm teammates.
- [ ] Paste each section above into the matching field.
- [ ] Select only sponsor tools with evidence above, and remove the `paypal-agent-toolkit` tag.
- [ ] Confirm the YouTube link is still public and under 3 minutes, and that the #21 checks are recorded.
- [ ] Add Sandbox test buyer details only in the form's private testing field.
- [ ] File the APIMatic claim form if the team enters that prize.
- [ ] Confirm the #56 hosting decision.
- [ ] Re-run `/api/health` and compare the commit with the table.
- [ ] Save the draft and submit before Nov 12, 2026 12:00 pm PST (20:00 UTC).
