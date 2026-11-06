# Contributing

Keep changes small, tied to an issue and within the area you own. Check current `main`, the issue's owner and dependencies, then coordinate before changing a shared service or schema. Follow [the collaboration workflow](docs/collaboration.md)

## Checks

Run these before publication from a clean, current branch:

```bash
npm run lint
npm test                 # disposable PostgreSQL 17 via TEST_DATABASE_URL
npm run build
```

CI runs the full checks. A unit test does not prove a deployed route, external MCP client or real PayPal payment. Record the exact commit, checks and remaining blockers in the issue

## Shared guidance and docs

Use the repository-wide [AGENTS.md](AGENTS.md) and project skills under [`.agents/skills`](.agents/skills/unslop/SKILL.md) for shared agent instructions. Keep provider-specific `.claude` or `.codex` configuration only when it contains real provider-specific settings; there is no shared MCP configuration format to assume

Update the relevant README, DEVELOP or `docs/` pages and `CHANGELOG.md` in the same logical change when behavior, configuration, commands or paths change. Do not claim releases, checks or external results that did not happen. Before committing, check local links and anchors, commands and newly added external references

Do not commit secrets, real customer data or local proof journals. Keep sandbox credentials in ignored local environment files or the deployment secret store
