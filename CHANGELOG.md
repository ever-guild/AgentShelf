# Changelog

This project has no tagged releases yet, entries describe code present in the current unreleased repository state, not end-to-end acceptance

## Unreleased

- Use PayPal City and Country only as editable shop-location suggestions
- Refresh the PayPal Login access token before reading UserInfo, following PayPal's documented code-to-profile flow; tokens remain in memory only
- Added bounded PayPal sign-in failure diagnostics without logging credentials, authorization codes or profile values
- Fixed PayPal profile requests to use the OpenID schema and made PayPal the primary owner sign-in path, with legacy access under other options
- Set the shared ink accent to PayPal blue and match the homepage demo action to the hosted Login button radius
- Use PayPal's official hosted login button across seller entry points and document rejected Login troubleshooting
- Clarified that the privacy policy covers AI service providers and connected assistants
- Added public Privacy policy and User agreement pages for Sandbox PayPal login consent
- Clarified platform PayPal API paths, required permissions and the remaining Sandbox proof steps
- Reorganized the environment template around the Platform app, marked direct-merchant settings as optional diagnostics and removed the unused Bryntum Business-key placeholder
- Added PayPal Sandbox identity login and shop confirmation, separate from merchant payment consent, real Login verification requires app configuration
- Added owner registration, shop creation, shop-scoped seller grants and seller MCP routes
- Added quantity inventory and reservation behavior shared with checkout
- Added Sandbox platform merchant-connection and PayPal webhook handling paths
- Moved the shared `unslop` skill from `.claude/skills` to `.agents/skills`
- Added `DEVELOP.md` and `CONTRIBUTING.md`, and updated operator documentation for registration, integrations, deployment and proof boundaries
- Fixed merchant connection origin handling on Render and the PayPal return URL

PayPal Sandbox consent, OAuth, order approval, capture and webhook delivery still need end-to-end evidence; see [the proof runbook](docs/paypal-sandbox-proof.md)
