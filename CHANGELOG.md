# Changelog

This project has no tagged releases yet, entries describe code present in the current unreleased repository state, not end-to-end acceptance

## Unreleased

- Record the first paid buyer run in claude.ai through the custom connector (10 November, 10.90 EUR, order `paid`) in the capability matrix, MCP status, partner notes, full-run notes and submission draft, with what that run did not cover. Refs: #19

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
