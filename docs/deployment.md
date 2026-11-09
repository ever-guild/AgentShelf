# Deployment

How AgentShelf runs on Render, for [#4](https://github.com/ever-guild/AgentShelf/issues/4)

[`render.yaml`](../render.yaml) describes the existing AgentShelf web service and its Postgres database in Frankfurt, [CI](../.github/workflows/ci.yml) validates updates to [main](https://github.com/ever-guild/AgentShelf/tree/main) before a GitHub Actions deploy job triggers Render with the exact commit SHA

## Status

Automated delivery is verified for [commit 3480a27](https://github.com/ever-guild/AgentShelf/commit/3480a271ae2e7159d030da8a37b8ea256481960b): [GitHub Actions run 42095505096](https://github.com/ever-guild/AgentShelf/actions/runs/42095505096) passed validation and deployment, Render deploy [dep-dbmdlv49v7es73cnr5dg](https://dashboard.render.com/web/srv-dbm8a6e1egvs73bl8d90/deploys/dep-dbmdlv49v7es73cnr5dg) became live at 2026-11-05 19:38:44 UTC and the health SHA matched the commit

This is a verified snapshot, later commits have their own checks and deployment records in [issue #31](https://github.com/ever-guild/AgentShelf/issues/31)

| Verified commit | Public URL | Smoke check |
| --- | --- | --- |
| [`3480a271ae2e7159d030da8a37b8ea256481960b`](https://github.com/ever-guild/AgentShelf/commit/3480a271ae2e7159d030da8a37b8ea256481960b) | [Demo](https://agentshelf-e5bk.onrender.com) | `/`, `/api/health`, `/api/health/ready`: HTTP 200; SHA matched |

## Automatic demo updates

- Pushes to `main` run lint, the full test suite with a disposable PostgreSQL 17 service, and the production build on Node.js 24
- The GitHub Environment [`agentshelf-e5bk.onrender.com`](https://github.com/ever-guild/AgentShelf/settings/environments/26743899833/edit) is the source of truth for the three AI provider settings and the AG Studio licence secret; after validation, Actions synchronizes those four named keys to the existing Render service through individual-key API requests
- The sync reads all four current Render values before writing, changes only values that differ, verifies the readback in memory and never logs values; unrelated service settings remain untouched, and a missing GitHub setting or failed read/write prevents the deploy step
- After the sync passes, Actions sends a POST request to Render's Deploy Hook using repository secret `RENDER_DEPLOY_HOOK_URL`, following [Render's Deploy Hook documentation](https://render.com/docs/deploy-hooks)
- The deploy script records the latest Render deploy IDs before the hook, then waits for a new `deploy_hook` deployment for `GITHUB_SHA` to become `live`; only then it checks public `/api/health` for that SHA, `/api/health/ready`, and the home page
- A manual **Run workflow** from `main` runs validation, re-syncs the same four settings and requests a same-SHA redeploy, even if values already match; use it to retry a failed rollout or apply a configuration-only change
- Deploy workflows share a non-canceling concurrency group, so a newer push or manual run cannot cancel the active Render sync/deploy and verification sequence; GitHub keeps at most one pending run per group
- Repository Actions secret `RENDER_DEPLOY_HOOK_URL` and Environment secret `RENDER_API_KEY` are required, keep their values out of chat, documentation and Git, and the scripts validate the hook and target a fixed Render service
- Render's native auto-deploy is configured as `autoDeployTrigger: off`, automated delivery is controlled by the GitHub Actions deploy job
- A Git tag records a demo version, it neither deploys nor freezes this service
- Record the live commit from `/api/health` and compare it with the successful GitHub Actions commit and Render deploy, do not treat a successful build as proof that a version is live
- Before freezing the judging version, disable or gate the GitHub Actions deploy job and record the chosen commit, Render's native auto-deploy is already off and a tag alone does not stop Deploy Hook requests

The validation job needs no Render credentials and uses only an isolated test database, never the demo database; only the post-validation job receives Render credentials and AI provider settings

## Plan decision needed before judging

The web service already uses `0.5c-512mb`, this setup preserves its existing plan, the new database uses `free`

| Resource | Current state | Follow-up |
| --- | --- | --- |
| Postgres | Free instance expires on 5 December 2026 | Obtain the owner's decision on a paid plan before expiry and confirm coverage through judging |
| Web service | Existing `0.5c-512mb` instance | Keep this plan unless the owner requests a change |

Confirm the current [free database limits](https://render.com/docs/free#free-render-postgres) and [pricing](https://render.com/pricing) before upgrading, claimed hackathon credits and their remaining balance must be verified in the workspace, [integrations.md](integrations.md) explains how to claim them

A Hobby workspace allows one team member, so one person holds the Render account unless the workspace moves to Pro.

## Existing deployment

The current [web service](https://dashboard.render.com/web/srv-dbm8a6e1egvs73bl8d90) was created before this Blueprint, its settings are managed through Render directly, automatic Blueprint synchronization has not been configured

1. Reuse the existing service and database, do not create another Blueprint stack for the same demo
2. Keep the Render settings aligned with [render.yaml](../render.yaml), committing this file alone does not update a service that is not managed by a Blueprint
3. After CI passes, the Actions deploy job requests the exact `GITHUB_SHA`; monitor that Render deploy until its status is `live`, then run the [smoke check](#smoke-check)
4. Seed synthetic demo data once, then verify that a restart preserves it and record the tested commit, public URL and result

If the resources are later imported into a Blueprint, review resource matching, plans and environment variables before applying it, the web service name is case-sensitive in this configuration and must remain `AgentShelf`

To check a change to the blueprint first, run the following. It needs `render login` and `render workspace set`.

```bash
render blueprints validate render.yaml
```

## What happens on a deploy

1. **Build:** `npm ci --include=dev && npm run build`. This needs no database and no secrets.
2. **Start:** `npm run db:migrate && npm run start`. Migrations run first, and the server only starts if they succeed. A database with no shop then gets the demo data.
3. **Health check:** Render waits for `/api/health` before sending traffic to the new version.

A redeploy never resets demo data. Migrations only apply what is pending, and the seed runs on a start only if the database holds no shop at all.

Migrations run in the start command because `preDeployCommand` is only available on paid web services. This works on every plan, so moving to a paid plan changes nothing here. Development dependencies stay installed because `db:migrate` runs through `tsx`.

## Seed the demo data

**An empty database seeds itself.** On Render, `npm run db:migrate` seeds the demo data if the database holds no shop, because opening the Shell takes the account owner, while anyone who can push to `main` can deploy. It covers a recreated database too. A database with any shop is left exactly as it is. A seed that fails logs `Demo seed failed`, the service starts anyway, and the next start tries again.

Run the seed by hand to apply seller codes or PayPal merchant IDs added later, or to put the seed's own rows back. The production database has external access disabled, so local seeding through its external URL is unavailable, and external access should not be enabled just to seed.

Open the [web service](https://dashboard.render.com/web/srv-dbm8a6e1egvs73bl8d90) in the Render Dashboard and go to its Shell page, which [needs no SSH key on a paid service](https://render.com/docs/ssh). Then run:

```bash
npm run db:seed
```

The same command works over SSH once the operator's public key is configured. An attempt without one failed with `Permission denied (publickey)`.

```bash
render ssh srv-dbm8a6e1egvs73bl8d90 --output text -- -o BatchMode=yes 'npm run db:seed'
```

Either way, the seed uses the internal `DATABASE_URL` and these demo values from the service environment. Both are optional, and each is kept as it is if not set.

- `DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID` and `DEMO_PHONE_WORKSHOP_SELLER_CODE`, and the same two for the second shop with `DEMO_SECOND_SHOP_`.
- `DEMO_DATE`, to fix the demo's "today".

Seeding again resets only the seed's own rows. `npm run demo:reset` also removes extra demo-shop listings, restores fixed demo stock through audited adjustments, and restores the demand fixtures. It runs only with `DEMO_ENVIRONMENT=true` on the service and refuses to run while any demo inventory reservation is active or unresolved. [Demo data](architecture.md#demo-data) explains both.

After seeding, run the [MCP smoke check](#smoke-check) so that it finds the product, restart the service, and run it again. That shows a record surviving a restart, and the result belongs in [#17](https://github.com/ever-guild/AgentShelf/issues/17).

## Environment variables

| Variable | Source | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Service secret, internal Render Postgres URL | Private network connection string, never commit its value |
| `TEST_DATABASE_URL` | Local test environment only | Disposable database used by `npm test`; do not point it at demo data |
| `APP_SIGNING_SECRET` | Service secret, generated once | Signs seller sessions and order status tokens, preserve it across redeploys |
| `RENDER` | Set by Render | Seeds an empty database on start |
| `RENDER_EXTERNAL_URL` | Set by Render | Public origin for PayPal return URLs and the MCP endpoint |
| `APP_ORIGIN` | Optional, by hand | Overrides the public origin, for a custom domain or local use; `.env.example` sets the local default |
| `MCP_ALLOWED_ORIGINS` | Optional, by hand | Extra browser origins for the MCP endpoint, comma separated. See [mcp.md](mcp.md#origin-handling) |
| `NODE_VERSION`, `NEXT_TELEMETRY_DISABLED` | Service settings mirrored in the Blueprint | Runtime settings |
| `AGENT_SHELF_AI_PROVIDER`, `AGENT_SHELF_AI_PROVIDER_BASE_URL` | GitHub Environment `agentshelf-e5bk.onrender.com`; synced to Render after CI validation | AI provider and HTTPS API root. The environment is authoritative; the workflow currently validates `openai` and `https://api.openai.com/v1` |
| `AGENT_SHELF_AI_PROVIDER_API_KEY` | GitHub Environment secret `agentshelf-e5bk.onrender.com`; synced to Render after CI validation | OpenAI key, never printed or stored in Git; used to read price list photos, suggest descriptions and search terms, and write demand notes. Until configured, photo upload explains that and CSV upload still works. See [AI providers](architecture.md#ai-providers) |
| `RENDER_API_KEY` | GitHub Environment secret `agentshelf-e5bk.onrender.com` for Actions | Render API credential used by the deployment job to sync managed settings and check the deploy; it is not copied into the application |
| `RENDER_DEPLOY_HOOK_URL` | GitHub Actions repository secret | Triggers the exact-SHA deploy after the environment sync; keep the URL private |
| `ANTHROPIC_API_KEY` | Secret, by hand, older | Claude only, read while `AGENT_SHELF_AI_PROVIDER` is blank |
| `RENDER_WORKFLOW_SLUG`, `RENDER_API_KEY` | Optional web-service settings, configured separately | Run photo reading as a Render Workflow; this runtime `RENDER_API_KEY` is independent of the GitHub Environment credential used by Actions. See [Render Workflows for photo import](#render-workflows-for-photo-import) |
| `RENDER_USE_LOCAL_DEV`, `RENDER_LOCAL_DEV_URL` | Local workflow development only | Point the Render SDK at the CLI task server; see [Render's local workflow guide](https://render.com/docs/workflows-local-development) |
| `PAYPAL_PLATFORM_CLIENT_ID`, `PAYPAL_PLATFORM_CLIENT_SECRET`, `PAYPAL_PLATFORM_MERCHANT_ID`, `PAYPAL_PARTNER_ATTRIBUTION_ID` | Platform app secrets and settings | Primary seller-consent and payment path; use [Sandbox platform setup](paypal-platform-setup.md) |
| `PAYPAL_PLATFORM_WEBHOOK_ID`, `PAYPAL_PLATFORM_PAYMENT_WEBHOOK_ID` | Platform app webhook subscriptions | Separate consent-revocation and payment subscriptions, see [PayPal Sandbox setup](paypal-sandbox-setup.md#webhooks) |
| `PAYPAL_LOGIN_CLIENT_ID`, `PAYPAL_LOGIN_CLIENT_SECRET` | Optional Sandbox app settings | Seller Login only; these may copy the Platform app values if that app has Log in with PayPal enabled, see [seller Login](paypal-login.md) |
| `PAYPAL_CLIENT_ID_DEMO_*`, `PAYPAL_CLIENT_SECRET_DEMO_*`, `PAYPAL_WEBHOOK_ID_DEMO_*` | Optional legacy diagnostic app secrets | Direct-merchant demo checkout and `paypal:proof`; not required for Platform seller consent |
| `DEMO_*_PAYPAL_MERCHANT_ID`, `DEMO_*_SELLER_CODE`, `DEMO_DATE`, `DEMO_ENVIRONMENT` | Optional demo seed/reset values | Configure the seeded shops and guarded demo reset, see [architecture](architecture.md#demo-data) |
| `AGENT_SHELF_AG_STUDIO_LICENCE` | GitHub Environment secret `agentshelf-e5bk.onrender.com` | Canonical AG Studio Pro with AI licence secret; synced only to the web service as `AG_STUDIO`. Keep it out of Git, issues, chat and screenshots |
| `AG_STUDIO` | Render web-service runtime variable; local `.env.local` key | Read by the seller dashboard and passed to AG Studio in the browser, where the library validates it. Without it, the dashboard uses Studio's trial state |

Use [`.env.example`](../.env.example) as the local template, it lists the primary Platform app first and keeps direct-merchant diagnostics separate. Login has its own environment names even when it reuses the Platform app credentials. Configure service secrets through the Dashboard or API; Render ignores `sync: false` entries added to an existing Blueprint after creation

The current schedule uses Bryntum Community and needs no license environment variable. A Business license is not wired into this runtime

## Render Workflows for photo import

Photo reading works without this, inside the web service. A workflow service moves it out, and it is what the [Render prize](https://paypalaihackathon.devpost.com/details/render) looks for. It has not been created: it needs the Render account owner, because its compute is billed by use, and no free allowance is listed. `render.yaml` describes it, and committing that file does not create it.

1. In the Dashboard choose **New > Workflow** and link this repository.
2. Name it `agentshelf-import`. Set **Language** to Node, **Region** to Frankfurt, **Build Command** to `npm ci --include=dev` and **Start Command** to `npx tsx workflows/main.ts`.
3. On the workflow, set `NODE_VERSION` to `24`, `DATABASE_URL` to the database's internal URL and the same AI settings as the web service: `AGENT_SHELF_AI_PROVIDER`, `AGENT_SHELF_AI_PROVIDER_BASE_URL`, `AGENT_SHELF_AI_PROVIDER_API_KEY`.
4. On the web service, set `RENDER_WORKFLOW_SLUG` to the workflow's slug and `RENDER_API_KEY`.
5. Set the workflow's auto-deploy to run after checks pass, as `render.yaml` says. The CI deploy job only requests the web service, so a freeze has to turn this off too.
6. Run the check below. The run should appear under the workflow in the Dashboard.

Keep each AI key in a workspace or project with a low monthly spend limit, because the demo's seller code is shared with judges. The per-shop limits on photos bound the rest.

```bash
npm run smoke:import -- https://agentshelf-e5bk.onrender.com
```

It needs `DEMO_PHONE_WORKSHOP_SELLER_CODE`, the demo shop seeded with that code, and an AI key on the service. The second sample photo holds unclear prices and a note telling a model to change them:

```bash
npm run smoke:import -- https://agentshelf-e5bk.onrender.com test/fixtures/price-lists/ambiguous.png
```

## Health checks

| Path | Meaning | Failure |
| --- | --- | --- |
| `/api/health` | The process is running, and `commit` shows the deployed version. Render uses this one, and it does not touch the database, so a database outage does not restart a working service | No response |
| `/api/health/ready` | The database is reachable and migrated | `503` after at most about 5 seconds |

Neither reveals any configuration. The reason for a failure goes to the server log.

## Smoke check

Replace the host with the service URL. Both should return `200`. The current paid web service does not sleep on the free-service schedule.

```bash
curl -fsS https://YOUR-SERVICE.onrender.com/api/health
```

```bash
curl -fsS https://YOUR-SERVICE.onrender.com/api/health/ready
```

Then check the MCP endpoint, which needs the demo data seeded:

```bash
npm run smoke:mcp -- https://YOUR-SERVICE.onrender.com/mcp
```

Once a shop has sandbox credentials, `npm run smoke:checkout -- URL --wait` checks a complete payment as well, as [mcp.md](mcp.md#smoke-check) explains.

## Logs and restarts

These use the [Render CLI](https://render.com/docs/cli) and need `render login`. `render services` lists the IDs. They have not been run against this service yet.

| Task | Command |
| --- | --- |
| Follow logs | `render logs -r SERVICE_ID --tail` |
| Restart | `render restart SERVICE_ID` |
| List deploys | `render deploys list SERVICE_ID` |
| Deploy and wait | `render deploys create SERVICE_ID --wait` |
| Query the database | `render psql DATABASE_ID -c "SELECT count(*) FROM products;"` |

The Dashboard offers the same logs and a manual deploy.

## If a migration fails

- `npm run db:migrate` exits with an error, so the server does not start. All pending migrations run in one transaction, so the database stays as it was.
- Per Render's documentation, the deploy then fails and the previous version keeps serving.
- To recover, fix the migration and push. Never edit a migration that has already been applied: add a new one.
- The old version keeps serving while a new one migrates, so a migration must stay compatible with the previous code. Add columns first, and remove them in a later deploy.

The same failure happens if the database is unreachable. `npm run db:migrate` gives up after about 5 seconds.
