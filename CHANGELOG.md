# Changelog

This project has no tagged releases yet, entries describe code present in the current unreleased repository state, not end-to-end acceptance

## Unreleased

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
