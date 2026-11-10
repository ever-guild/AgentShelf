# Changelog

This project has no tagged releases yet, entries describe code present in the current unreleased repository state, not end-to-end acceptance

## Unreleased

- Put the owner's own assistant first in the seller screens: a new `/seller/assistant` screen, first in the menu and where a shop sign-in lands, shows the three steps to work through an assistant (issue access, connect to the shop's seller MCP address, ask in plain words) and what stays with the owner. The issued-credential panel in `/seller/agent-access` now shows the address to connect to, the price list and catalog screens carry a one-line example request, and the schedule says that buyers' assistants hold and book its slots. No seller tool, grant rule or screen is removed.

- Rebuild the homepage around both sides working through an assistant: a dark opening band with a scene that plays one sale in three panels (the owner's assistant, the record AgentShelf keeps, the buyer's assistant) on the demo seed's data, a list of what an assistant could get wrong and the rule that prevents it, the four Sandbox payments of 10 November, the price list becoming a catalog, an example day's schedule and missed searches, who can pay, and the connector. Motion plays once and rests in its final state; the design direction records the dark band and the motion rule.

- Include the shop payment-readiness snapshot in buyer product search results so assistants can avoid offering checkout or booking for shops that are not currently ready. This field is not proof of payment. Refs: #19

- Make two statements in the submission draft exact: the import leaves a price that is not a single amount for the seller to fill in, instead of "nothing is guessed", and the price list was imported once, in the first of the three rehearsals. Refs: #22

- Correct the buyer MCP row of the capability matrix, which said both that ChatGPT completed a paid purchase and that ChatGPT is not tested: the untested part is a repair booking from ChatGPT. Refs: #19

- Add screenshots of the ChatGPT purchase and the Claude repair booking to the submission draft, in the story and in the gallery list. Refs: #22

- Add two screenshots of the live service to the submission draft, embed them in the story and list them for the gallery, and name the phone shop and the tiler in the Inspiration section. Refs: #22

- Add to the submission draft's Inspiration section the four small-business owners the team described the idea to, stated as informal conversations with family and acquaintances. Refs: #22

- Record the first paid purchase through ChatGPT with the buyer connector installed as a custom MCP server (10 November, 14.00 EUR, order `paid`). Refs: #19

- Record a repair booking with a paid 20 EUR deposit made in the claude.ai web client through the custom connector (10 November), which completes the five buyer tools for that connector, and the buyer's report of why the ChatGPT order was not paid. Refs: #19

- Record the first ChatGPT session through the buyer connector (10 November): tool listing, search and one checkout passed, and the order ended in `review_required` instead of `paid`, cause not confirmed. Add the model of the Claude desktop run. Refs: #19

- Record the first paid buyer run through the Claude custom connector, in the Claude desktop app on a Max plan (10 November, 10.90 EUR, order `paid`) in the capability matrix, MCP status, partner notes, full-run notes and submission draft, with what that run did not cover. Refs: #19

- Replace the default favicon with the AgentShelf mark, an outline letter A with a blue dot on a dark tile, as `icon.svg`, a 16/32/48 `favicon.ico` and a 180px `apple-icon.png`.

- Record the first human Sandbox purchase through the storefront PayPal button (10 November, live `5c4daf9`, 7.50 EUR) in the capability matrix, partner notes, full-run notes and submission draft, with the checks that were not read for that order. Refs: #19

- Rewrite the paste-ready submission text around the judging criteria: problem and demonstrated result first, one paragraph per partner tool, open checks reduced to a "Verified scope" paragraph that links to the capability matrix. Record the public video link and length, the live check on `eb41627`, the unused `paypal-agent-toolkit` tag and the unfiled APIMatic claim. Refs: #22

- Add interactive Claude and ChatGPT connection actions on the homepage, with copyable MCP connector address, accurate clipboard fallback states, safe search and Sandbox checkout prompts, human payment approval guidance, and a concise buyer quickstart ([docs/buyer-quickstart.md](docs/buyer-quickstart.md)). Refs: #19

- Restore the six-column capability-matrix structure for Channel3 evidence and limits. Refs: #19

- Clarify the evidence-level definitions and update ChatGPT plugin installation steps from current documentation. Refs: #19

- Refresh the submission draft against `11f634e`, retain historical `198bc1f` checks, and cite Newman, Channel3 browser/API evidence, full CI and live health while preserving the final browser-check limit. Refs: #22

- Align the capability and partner evidence matrix with dated hosted checks, mutating rehearsals, the verified AG Studio licence, and the unresolved hosted Workflow gate. Refs: #19

- Add seller-side Channel3 catalog enrichment with validated, bounded candidate searches and explicit selection of suggested product matches. Provider API and browser lookup were verified on `5348463`; hosted deployment and later SSR replay evidence are recorded in the capability matrix. Refs: #24

- Prepare Render Workflow releases with a revision marker generated from the workflow build's Git checkout; CI verifies the selected new version registers the marker for the requested SHA and the import task. Hosted activation and photo processing remain unverified. Refs: #55

- Redesign toward one light theme: a single-column homepage that shows the demo workshop's price list, the catalog it becomes and an order through a buyer's assistant, the current seller page underlined in the header, and a default dashboard of six widgets drawn as sheets on a white canvas, with payment status as four totals in a row and an orders grid of six columns. Arranging opens with Studio's side panels closed. A saved dashboard arrangement resets once

- Use the same `AG_STUDIO` secret name in the demo GitHub Environment and Render web-service runtime setting

- Rewrite search terms written under an older prompt version, and ask for a brand's spelling in each language's alphabet (`search-terms-v2`), so Cyrillic `айфон` finds iPhone listings

- Sync the demo AI provider settings from the GitHub Environment to the existing Render service before exact-SHA deployments, verify the new deployment, and allow manual same-SHA redeploys from `main`

- Add an OpenAI adapter next to Claude for photo import, descriptions, search terms and demand insights, configured with `AGENT_SHELF_AI_PROVIDER`, `AGENT_SHELF_AI_PROVIDER_BASE_URL` and `AGENT_SHELF_AI_PROVIDER_API_KEY`, with the shared prompts in one module. A deployment with only `ANTHROPIC_API_KEY` keeps running on Claude

- Document reproducible local setup, seller MCP rehearsals and the verified integration boundaries for the final milestone run

- Update user and operator documentation for final milestone handoff: structure README around owner walkthrough and agent surfaces, add capability matrix ([docs/capabilities.md](docs/capabilities.md)), align AGENTS.md stack and proof boundaries, and harmonize partner integrations (#19).

- Let a workshop owner set up technicians and their weekly working hours on `/seller/schedule`, so a newly registered workshop offers repair slots without database edits

- Polish the seller price list screens: the product name and PayPal Sandbox in the header, a larger drop zone, a how-it-works empty state and Read, Check and Publish steps driven by each import's status

- Render Log in with PayPal as a custom button built to PayPal's Button design guide, so it stays sharp on high-density screens

- Add explicit stock policy and versioned quantity controls to the seller catalog, with reconfirmation after conflicts

- Reflect explicit stock policy and available quantities in buyer search and storefront availability without hiding listings

- Clear stale PayPal connection links and ignore old-shop responses after switching shops; preserve consent-gated recovery actions

- Give seller MCP clients fixed recovery guidance, including the explicit inventory-policy step for newly published products; sanitize error codes and owner authorization links
- Document the real external Claude Code seller rehearsal and distinguish live evidence from locally tested recovery behavior
- Let owners resume pending PayPal Sandbox approval after re-confirming shop data sharing
- Accept PayPal's documented Sandbox Partner Referrals `self` host alias and `bizsignup` action link while keeping exact host/path/query validation
- Use PayPal City and Country only as editable shop-location suggestions
- Refresh the PayPal Login access token before reading UserInfo, following PayPal's documented code-to-profile flow; tokens remain in memory only
- Added bounded PayPal sign-in failure diagnostics without logging credentials, authorization codes or profile values
- Fixed PayPal profile requests to use the OpenID schema and made PayPal the primary owner sign-in path, with legacy access under other options
- Set the shared ink accent to PayPal blue and match the homepage demo action to the hosted Login button radius
- Use the Log in with PayPal button across seller entry points and document rejected Login troubleshooting
- Clarified that the privacy policy covers AI service providers and connected assistants
- Added public Privacy policy and User agreement pages for Sandbox PayPal login consent
- Clarified platform PayPal API paths, required permissions and the remaining Sandbox proof steps
- Reorganized the environment template around the Platform app, marked direct-merchant settings as optional diagnostics and removed the unused Bryntum Business-key placeholder
- Added PayPal Sandbox identity login and shop confirmation, separate from merchant payment consent, real Login verification requires app configuration
- Added owner registration, shop creation, shop-scoped seller grants and seller MCP routes
- Added quantity inventory and reservation behavior shared with checkout
- Allow owner and legacy shop sessions to manage audited stock; release physical holds only after verified unpaid outcomes, retry approved captures with the same request ID only while the allocation is live, and preserve ambiguous or unallocated purchases for review
- Keep physical stock reserved when a PayPal same-ID capture conflict reports a request in progress, including HTTP 422
- Restore fixed synthetic demo stock through audited adjustments; refuse reset while any purchase payment is unresolved, including legacy orders without allocation
- Added Sandbox platform merchant-connection and PayPal webhook handling paths
- Moved the shared `unslop` skill from `.claude/skills` to `.agents/skills`
- Added `DEVELOP.md` and `CONTRIBUTING.md`, and updated operator documentation for registration, integrations, deployment and proof boundaries
- Fixed merchant connection origin handling on Render and the PayPal return URL

Verified evidence and remaining rehearsal limits are recorded in [the proof runbook](docs/paypal-sandbox-proof.md) and [merchant connection contract](docs/paypal-merchant-connection.md); implementation entries alone do not certify end-to-end acceptance.
