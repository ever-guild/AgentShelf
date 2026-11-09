# Render Workflows for photo import

How price-list photos are read by a Render Workflow task instead of the web process, for [#55](https://github.com/ever-guild/AgentShelf/issues/55). Hosting, the deploy job and the managed AI settings are described in [deployment.md](deployment.md).

## What is proven and what is not

| Level | State | Evidence |
| --- | --- | --- |
| Blueprint candidate | `render.yaml` describes the workflow `agentshelf-import`; `render blueprints validate` passes | Validation only. Committing the file creates nothing |
| Local and mocked | The task `extractPriceList` registers on the local task server (`render workflows dev`). Starts, retries, duplicate dispatch, fallback and CI delivery are covered by unit and PostgreSQL tests with a fake Render client | `npm test` |
| Hosted resource | **Not created.** No workflow exists in the Render workspace | Read-only Render API listing |
| Hosted import | **Not run.** No photo has been read by a hosted task run | — |

Until the last two rows change, photo reading runs inside the web service, and the Render prize claim is limited to hosting plus a workflow implementation that was validated locally.

## How a run works

1. A seller uploads a photo. The web service stores the photo and an import job in PostgreSQL, then starts `<workflow-slug>/extractPriceList` with one argument: the job ID. The photo, the shop ID and credentials are never task arguments.
2. The start carries the idempotency key `<job ID>:<job updated-at>`. A repeated start of an unchanged job within 24 hours returns the run that already exists, and the job keeps the task run ID.
3. The task claims the job in the database. A duplicate or late delivery finds it taken or finished and does nothing, so it cannot add rows twice.
4. A transient failure, such as a model timeout, is thrown so Render retries it: three attempts in all, with a 300-second timeout per attempt. A failure that repeating cannot fix is recorded on the job and not retried. Input that is not a job ID is rejected without a retry.
5. The task writes draft rows for seller review. Nothing is published until the seller publishes it.

### When the workflow is unavailable

- If a start fails, for example Render is unreachable or the task is missing, the web service logs `Render Workflow start failed` with the job ID and HTTP status, and the job stays `queued`. The import sweep tries again after about a minute and marks a job that never started as failed after 15 minutes. The seller can retry it.
- If `RENDER_WORKFLOW_SLUG` is set but the service has no Render credential, imports run in the web process. The service logs this once at startup as `Render Workflow configured but not reachable`, and every in-process run is logged with `runner: "web-process"`. Such a run is not a hosted run.
- A hosted run is identified by the task run ID stored on the import job and logged as `Import run started` with `runner: "render-workflow"`.

## Configuration

| Setting | Where | Purpose |
| --- | --- | --- |
| `RENDER_WORKFLOW_ID` | GitHub Environment `agentshelf-e5bk.onrender.com`, variable (not a secret) | When set, the deploy job syncs AI settings and requests a workflow release with the CI commit. It verifies a newly-created version registers both `extractPriceList` and the build-stamped `revision_<CI SHA>` marker task. When unset, the job behaves as before |
| `AGENT_SHELF_AI_PROVIDER`, `AGENT_SHELF_AI_PROVIDER_BASE_URL`, `AGENT_SHELF_AI_PROVIDER_API_KEY` | GitHub Environment; synced to the web service and, when `RENDER_WORKFLOW_ID` is set, to the workflow | The model used to read photos. `AG_STUDIO` is never sent to the workflow |
| `DATABASE_URL`, `NODE_VERSION` | Workflow, from the Blueprint | The same database as the web service, by its internal URL |
| `RENDER_WORKFLOW_SLUG` | Web service runtime | Turns on dispatch. Set it last, after the task is verified |
| `RENDER_API_KEY` (runtime) | Web service runtime only | Lets the web service start task runs. A separate key from the CI credential, see below |

### The runtime credential

The Render SDK starts runs through the Render API and needs an API key, read from `RENDER_API_KEY` ([TypeScript SDK](https://render.com/docs/workflows-sdk-typescript), [Triggering runs](https://render.com/docs/workflows-running)). A standard Render API key acts with its creator's full account access. Scoped keys limited to one workspace are in early access ([Render API](https://render.com/docs/api)).

- Do not copy the CI `RENDER_API_KEY` from the GitHub Environment into the web service, and never use a temporary CLI login token.
- Create a dedicated key for this purpose only: scoped to the `AgentShelf` workspace if scoped keys are available to the account, otherwise created by an account whose only workspace is `AgentShelf`. Name it for this use so it can be revoked on its own.
- Store it only as the web service's `RENDER_API_KEY`. The workflow itself does not need it.
- Revoking the key turns hosted starts into logged failures that the sweep retries. It does not lose uploaded jobs.

## Activation (Render owner and root integrator)

This changes billing. Do it only after the cost plan in [#56](https://github.com/ever-guild/AgentShelf/issues/56) is approved, and outside a recording window.

1. Create the workflow from the Blueprint, or in the Dashboard with **New > Workflow**: name `agentshelf-import`, repository `ever-guild/AgentShelf`, branch `main`, Node, Frankfurt, build `npm ci --include=dev`, start `npx tsx workflows/main.ts`, auto-deploy off. Do not set a plan. Task compute is chosen in code, and the default is `flex`.
2. Set `NODE_VERSION=24` and `DATABASE_URL` to the database's internal URL on the workflow.
3. Set the GitHub Environment variable `RENDER_WORKFLOW_ID` to the new workflow's ID, then run the CI workflow on `main`. The deploy job syncs the three AI settings to the workflow, requests release with the same commit as the web service, waits for one newly-created version to be `ready`, and checks that both `extractPriceList` and `revision_<CI SHA>` are registered for that version. The revision marker is generated from the workflow build checkout and registered without executing it; this binds the selected version's registered task manifest to the requested commit even though Render's version API does not expose a commit field. Record the workflow ID, slug, version ID and SHA.
4. Create the runtime key as above, then set `RENDER_API_KEY` and `RENDER_WORKFLOW_SLUG` on the web service. Apply them with the next CI deploy, or a manual run of the CI workflow, so that the web revision is recorded.
5. Verify, and record each result:
   - The web service log shows no `not reachable` warning.
   - As a test owner, upload one synthetic photo, for example `test/fixtures/price-lists/` from this repository, to a test shop. The job gets a task run ID. The run appears under the workflow and completes, and the draft rows appear for review, unpublished.
   - The task run's input is exactly one job ID.
   - Retrying the upload's start, or a second sweep pass, does not create a second run or duplicate rows.
   - Optional failure check, on a test shop only: remove `RENDER_WORKFLOW_SLUG`, then confirm the warning and the `web-process` log line. Alternatively, with an invalid runtime key, confirm the logged start failure, the job left `queued` and its recovery after the key is restored.

Known limit of the release check: Render's documented workflow-version API accepts the commit on release but does not return a version ID or expose the commit on version records. The script snapshots existing version IDs, then accepts only one newly-created version belonging to the configured workflow; if multiple appear, it fails and asks the operator to check the Dashboard and retry without another release in progress. It verifies the commit through a revision marker task generated from the workflow build's checked-out SHA and only accepts the marker when registered to the selected version. Task registration is queried by that version ID. The hosted version-to-checkout marker behavior still requires a first activation check.

### Rollback

- Remove `RENDER_WORKFLOW_SLUG` from the web service and redeploy through CI. Imports go back to the web process, and jobs stay in PostgreSQL.
- Clear `RENDER_WORKFLOW_ID` in the GitHub Environment so CI stops syncing and releasing the workflow.
- Revoke the runtime key. Suspend or delete the workflow only after no run is in progress.

### Freeze

The workflow's own auto-deploy is off. Disabling the CI deploy job freezes both the web service and the workflow. Record the commit of both, which should be the same.

## Cost

Task runs are billed per second of compute on the `flex` plan by default, and their arguments and results are stored for 30 days ([Limits and Pricing](https://render.com/docs/workflows-limits)). A run here passes only a job ID, so stored state is negligible. Estimates and the approval state are tracked in [#56](https://github.com/ever-guild/AgentShelf/issues/56).

## Local development

```bash
render workflows dev -- npx tsx workflows/main.ts
render workflows tasks list --local
```

To start runs from a local web server, set `RENDER_USE_LOCAL_DEV=true` and `RENDER_WORKFLOW_SLUG` in `.env.local`, and point the task server at your own disposable database ([Render local development](https://render.com/docs/workflows-local-development)).
