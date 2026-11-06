# Changelog

This project has no tagged releases yet, entries describe code present in the current unreleased repository state, not end-to-end acceptance

## Unreleased

- Added PayPal Sandbox identity login and shop confirmation, separate from merchant payment consent, real Login verification requires app configuration
- Added owner registration, shop creation, shop-scoped seller grants and seller MCP routes
- Added quantity inventory and reservation behavior shared with checkout
- Added Sandbox platform merchant-connection and PayPal webhook handling paths
- Moved the shared `unslop` skill from `.claude/skills` to `.agents/skills`
- Added `DEVELOP.md` and `CONTRIBUTING.md`, and updated operator documentation for registration, integrations, deployment and proof boundaries
- Fixed merchant connection origin handling on Render and the PayPal return URL

PayPal Sandbox consent, OAuth, order approval, capture and webhook delivery still need end-to-end evidence; see [the proof runbook](docs/paypal-sandbox-proof.md)
