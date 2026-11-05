# Deployment

How AgentShelf runs on Render, for [#4](https://github.com/ever-guild/AgentShelf/issues/4). [`render.yaml`](../render.yaml) defines a web service and a Postgres database in Frankfurt, and Render deploys `main` automatically.

## Status

**Not deployed yet.** The behaviour below was checked locally, with the blueprint's start command and a real Postgres, unless it says otherwise.

| Deployed commit | Public URL | Smoke check |
| --- | --- | --- |
| None yet | | |

## Plan decision needed before judging

`render.yaml` uses the free plan for both resources. No paid plan is set without the account owner's decision, but the free plan will not last through judging:

| Resource | Free plan limit | Paid plan to move to |
| --- | --- | --- |
| Postgres | Expires 30 days after creation, and is deleted 14 days later unless upgraded. No backups, 1 GB | `0.1c-256mb`, $6 per month |
| Web service | Sleeps after 15 idle minutes and takes about a minute to wake, so a first MCP request or PayPal webhook may time out | `0.5c-512mb`, $7 per month |

Organisers ask teams to keep the demo, test credentials, trials and credits active until winners are announced on Dec 21. They also ask teams not to edit the repository after the Nov 12 deadline, so change the `plan` values and push **before Nov 12**. The $50 hackathon credit covers both plans until Dec 21. [integrations.md](integrations.md) explains how to claim it.

A Hobby workspace allows one team member, so one person holds the Render account unless the workspace moves to Pro.

## First deploy

1. In the Render Dashboard, create a Blueprint from this repository. Render creates the service and the database and generates `APP_SIGNING_SECRET`.
2. Run the [smoke check](#smoke-check).
3. Seed the demo data once, as described [below](#seed-the-demo-data).
4. Fill in the status table above with the commit, URL and result.

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

The seed runs from a developer machine, because a free service has no shell. Copy the External Database URL from the Render Dashboard and set these in `.env.local`, then run `npm run db:seed`:

- `DATABASE_URL`: the external URL, with `?sslmode=require` added. This path has not been run against Render yet.
- `DEMO_PHONE_WORKSHOP_PAYPAL_MERCHANT_ID` and `DEMO_PHONE_WORKSHOP_SELLER_CODE`.

Put your local `DATABASE_URL` back afterwards. Seeding again resets only the seed's own rows.

## Environment variables

| Variable | Source | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Blueprint, from the database | Private network connection string |
| `APP_SIGNING_SECRET` | Blueprint, generated once | Signs seller sessions and order status tokens |
| `RENDER_EXTERNAL_URL` | Set by Render | Public origin for PayPal return URLs and the MCP endpoint |
| `APP_ORIGIN` | Optional, by hand | Overrides the public origin, for a custom domain or local use |
| `MCP_ALLOWED_ORIGINS` | Optional, by hand | Extra browser origins for the MCP endpoint, comma separated. See [mcp.md](mcp.md#origin-handling) |
| `NODE_VERSION`, `NEXT_TELEMETRY_DISABLED` | Blueprint | Runtime settings |

PayPal, AI and partner variables are listed in [`.env.example`](../.env.example). Add them to the service in the Dashboard when the code that reads them lands. Render ignores `sync: false` entries added to a blueprint after it was created, so the Dashboard is the one place to set them.

## Health checks

| Path | Meaning | Failure |
| --- | --- | --- |
| `/api/health` | The process is running, and `commit` shows the deployed version. Render uses this one, and it does not touch the database, so a database outage does not restart a working service | No response |
| `/api/health/ready` | The database is reachable and migrated | `503` after at most about 5 seconds |

Neither reveals any configuration. The reason for a failure goes to the server log.

## Smoke check

Replace the host with the service URL. Both should return `200`. Expect up to a minute on a sleeping free service.

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
