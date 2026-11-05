# Deployment

How AgentShelf runs on Render, for [#4](https://github.com/ever-guild/AgentShelf/issues/4)

[`render.yaml`](../render.yaml) describes the existing AgentShelf web service and its Postgres database in Frankfurt, [CI](../.github/workflows/ci.yml) validates updates to [main](https://github.com/ever-guild/AgentShelf/tree/main) before a GitHub Actions deploy job triggers Render with the exact commit SHA

## Status

Hosting configuration was updated on 5 November 2026, manual recovery deploy [dep-dbmddsh5efls73c8ebkg](https://dashboard.render.com/web/srv-dbm8a6e1egvs73bl8d90/deploys/dep-dbmddsh5efls73c8ebkg) is live at commit [`77ed0664bc708d9642b02419b0e3e01698f40571`](https://github.com/ever-guild/AgentShelf/commit/77ed0664bc708d9642b02419b0e3e01698f40571), automated delivery is still pending verification

| Deployed commit | Public URL | Smoke check |
| --- | --- | --- |
| [`77ed0664bc708d9642b02419b0e3e01698f40571`](https://github.com/ever-guild/AgentShelf/commit/77ed0664bc708d9642b02419b0e3e01698f40571) | [Demo](https://agentshelf-e5bk.onrender.com) | `/`, `/api/health`, `/api/health/ready`: HTTP 200 |

## Automatic demo updates

- Pushes to `main` run lint, the full test suite with a disposable PostgreSQL 17 service, and the production build on Node.js 24
- After validation passes, the GitHub Actions deploy job sends a POST request to Render's Deploy Hook using repository secret `RENDER_DEPLOY_HOOK_URL`, following [Render's Deploy Hook documentation](https://render.com/docs/deploy-hooks)
- The deploy script waits for the Render deploy matching `GITHUB_SHA`, then checks public `/api/health` for that SHA and `/api/health/ready` for database readiness
- Repository Actions secret `RENDER_DEPLOY_HOOK_URL` is present, keep its value out of chat, documentation and Git, the deploy job verifies that it belongs to the expected service before use
- Render's native auto-deploy is configured as `autoDeployTrigger: off`, automated delivery is controlled by the GitHub Actions deploy job
- A Git tag records a demo version, it neither deploys nor freezes this service
- Record the live commit from `/api/health` and compare it with the successful GitHub Actions commit and Render deploy, do not treat a successful build as proof that a version is live
- Before freezing the judging version, disable or gate the GitHub Actions deploy job and record the chosen commit, Render's native auto-deploy is already off and a tag alone does not stop Deploy Hook requests

The validation job needs no Render credentials and uses only an isolated test database, never the demo database, only the post-validation deploy job receives the hook URL

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
2. **Start:** `npm run db:migrate && npm run start`. Migrations run first, and the server only starts if they succeed.
3. **Health check:** Render waits for `/api/health` before sending traffic to the new version.

A redeploy never resets demo data. Migrations only apply what is pending, and the seed is not part of a deploy.

Migrations run in the start command because `preDeployCommand` is only available on paid web services. This works on every plan, so moving to a paid plan changes nothing here. Development dependencies stay installed because `db:migrate` runs through `tsx`.

## Seed the demo data

The production database has external access disabled, so local seeding through its external URL is unavailable. The web service is paid and supports Render SSH, but the attempted SSH connection failed with `Permission denied (publickey)`. Configure the Render SSH public key for the operator before using this command; the demo database is not seeded yet:

```bash
render ssh srv-dbm8a6e1egvs73bl8d90 --output text -- -o BatchMode=yes 'npm run db:seed'
```

Do not enable external database access just to seed. Once SSH access is configured, the seed command uses the internal `DATABASE_URL` and demo credentials from the service environment.

- `DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID` and `DEMO_PHONE_WORKSHOP_SELLER_CODE`.

Seeding again resets only the seed's own rows. Confirm the command succeeds and verify seeded records before treating MCP smoke checks as ready.

## Environment variables

| Variable | Source | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Service secret, internal Render Postgres URL | Private network connection string, never commit its value |
| `APP_SIGNING_SECRET` | Service secret, generated once | Signs seller sessions and order status tokens, preserve it across redeploys |
| `RENDER_EXTERNAL_URL` | Set by Render | Public origin for PayPal return URLs and the MCP endpoint |
| `APP_ORIGIN` | Optional, by hand | Overrides the public origin, for a custom domain or local use |
| `MCP_ALLOWED_ORIGINS` | Optional, by hand | Extra browser origins for the MCP endpoint, comma separated. See [mcp.md](mcp.md#origin-handling) |
| `NODE_VERSION`, `NEXT_TELEMETRY_DISABLED` | Service settings mirrored in the Blueprint | Runtime settings |

PayPal, AI and partner variables are listed in [`.env.example`](../.env.example). Add them to the service in the Dashboard when the code that reads them lands. Render ignores `sync: false` entries added to a blueprint after it was created, so the Dashboard is the one place to set them.

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

Rerun these once the payment routes land.

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
