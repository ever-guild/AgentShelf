# Render Workflows for photo import

How price-list photos are read by a Render Workflow task instead of the web process, for [#55](https://github.com/ever-guild/AgentShelf/issues/55). Hosting, the deploy job and the managed AI settings are described in [deployment.md](deployment.md).

## What is proven and what is not

| Level | State | Evidence |
| --- | --- | --- |
| Blueprint candidate | `render.yaml` describes the workflow `agentshelf-import`; `render blueprints validate` passes | Validation only. Committing the file creates nothing |
| Local and mocked | The task `extractPriceList` registers on the local task server (`render workflows dev`). Starts, retries, duplicate dispatch, fallback and CI delivery are covered by unit and PostgreSQL tests with a fake Render client | `npm test` |
| Hosted resource | **Created** on 11 November 2026: workflow `agentshelf-import`, ID `wfl-dbq98bt9fdbs73domkcg`, Frankfurt, Node, auto-deploy off. CI released versions that registered `extractPriceList` and the `revision_<SHA>` marker | Render API readback, CI run 43067171628, see [Hosted run](#hosted-run-11-november-2026) |
| Hosted import | **Run once** on 11 November 2026: one synthetic photo, one task run, `completed`, 7 draft rows for review. Dispatch is **disabled again** since 17:31 UTC | Task run `trn-0854gdbqabtsr449g00eadvu0`, web log `runner: 'render-workflow'` |
| Hosted failure and fallback | Proven by mocked and local tests only, not by disabling production credentials | `npm test` |

Dispatch is off, so photo reading runs inside the web service again after the next deploy. The Render claim is limited to this: hosted Workflow import was demonstrated once on 11 November 2026 and is now disabled. It does not run on the live service.

## How a run works

1. A seller uploads a photo. The web service stores the photo and an import job in PostgreSQL, then starts `<workflow-slug>/extractPriceList` with one argument: the job ID. The photo, the shop ID and credentials are never task arguments.
2. The start carries the idempotency key `<job ID>:<job updated-at>`. A repeated start of an unchanged job within 24 hours returns the run that already exists, and the job keeps the task run ID.
3. The task claims the job in the database. A duplicate or late delivery finds it taken or finished and does nothing, so it cannot add rows twice.
4. A transient failure, such as a model timeout, is thrown so Render retries it: three attempts in all, with a 300-second timeout per attempt. A failure that repeating cannot fix is recorded on the job and not retried. Input that is not a job ID is rejected without a retry.
5. The task writes draft rows for seller review. Nothing is published until the seller publishes it.

### When the workflow is unavailable

- If a start fails, for example Render is unreachable or the task is missing, the web service logs `Render Workflow start failed` with the job ID and HTTP status, and the job stays `queued`. The import sweep tries again after about a minute and marks a job that never started as failed after 15 minutes. The seller can retry it.
- If `RENDER_WORKFLOW_SLUG` is set but the service has no Render credential, imports run in the web process. The first time the default import dependencies are initialized, the service logs `Render Workflow configured but not reachable`; every in-process run is logged with `runner: "web-process"`. Such a run is not a hosted run.
- A hosted run is identified by the task run ID stored on the import job and logged as `Import run started` with `runner: "render-workflow"`.

## Configuration

| Setting | Where | Purpose |
| --- | --- | --- |
| `RENDER_WORKFLOW_ID` | GitHub Environment `agentshelf-e5bk.onrender.com`, variable (not a secret) | When set, the deploy job syncs AI settings and requests a workflow release with the CI commit. It verifies a newly-created version registers both `extractPriceList` and the build-stamped `revision_<CI SHA>` marker task. When unset, the job behaves as before |
| `AGENT_SHELF_AI_PROVIDER`, `AGENT_SHELF_AI_PROVIDER_BASE_URL`, `AGENT_SHELF_AI_PROVIDER_API_KEY` | GitHub Environment; synced to the web service and, when `RENDER_WORKFLOW_ID` is set, to the workflow | The model used to read photos. `AG_STUDIO` is never sent to the workflow |
| `DATABASE_URL`, `NODE_VERSION` | Workflow | The same database as the web service, by its internal URL. Set on the workflow itself |
| `RENDER_WORKFLOW_SLUG` | Web service, set directly, never by CI | Turns on dispatch. Set it last, after the task is verified |
| `RENDER_API_KEY` (runtime) | Web service, set directly, never by CI | Lets the web service start task runs. A separate key from the CI credential, see below |

CI writes only the three AI provider settings. It never writes `RENDER_WORKFLOW_SLUG` or the runtime `RENDER_API_KEY`. The deploy scripts read and write workflow env vars at `/v1/services/{workflowId}/env-vars`; the build-source path returns 404. The deploy job timeout is 40 minutes.

### The runtime credential

The Render SDK starts runs through the Render API and needs an API key, read from `RENDER_API_KEY` ([TypeScript SDK](https://render.com/docs/workflows-sdk-typescript), [Triggering runs](https://render.com/docs/workflows-running)). A standard Render API key acts with its creator's full account access. Scoped keys limited to one workspace are in early access ([Render API](https://render.com/docs/api)).

- Do not copy the CI `RENDER_API_KEY` from the GitHub Environment into the web service, and never use a temporary CLI login token.
- Create a dedicated key for this purpose only: scoped to the `AgentShelf` workspace if scoped keys are available to the account, otherwise created by an account whose only workspace is `AgentShelf`. Name it for this use so it can be revoked on its own.
- Store it only as the web service's `RENDER_API_KEY`. The workflow itself does not need it.
- Revoking the key turns hosted starts into logged failures that the sweep retries. It does not lose uploaded jobs.

## Activation (Render owner and root integrator)

This changes billing. Do it only after the cost plan in [#56](https://github.com/ever-guild/AgentShelf/issues/56) is approved, and outside a recording window.

1. Create the workflow from the Blueprint, or in the Dashboard with **New > Workflow**: name `agentshelf-import`, repository `ever-guild/AgentShelf`, branch `main`, Node, Frankfurt, build `npm ci --include=dev && node scripts/write-workflow-revision.mjs`, start `npx tsx workflows/main.ts`, auto-deploy off. Do not set a plan. Task compute is chosen in code, and the default is `flex`.
2. Set `NODE_VERSION=24` and `DATABASE_URL` to the database's internal URL on the workflow.
3. Set the GitHub Environment variable `RENDER_WORKFLOW_ID` to the new workflow's ID, then run the CI workflow on `main`. The deploy job syncs the three AI settings to the workflow, requests release with the same commit as the web service, waits for one newly-created version to be `ready`, and checks that both `extractPriceList` and `revision_<CI SHA>` are registered for that version. The revision marker is generated from the workflow build checkout and registered without executing it; this binds the selected version's registered task manifest to the requested commit even though Render's version API does not expose a commit field. Record the workflow ID, slug, version ID and SHA.
4. Create the runtime key as above, then set `RENDER_API_KEY` and `RENDER_WORKFLOW_SLUG` on the web service directly. CI does not apply them. Deploy through CI afterwards, or run the CI workflow manually, so that the web revision is recorded.
5. Verify, and record each result:
   - The web service log shows no `not reachable` warning.
   - As a test owner, upload one synthetic photo, for example `test/fixtures/price-lists/` from this repository, to a test shop. The job gets a task run ID. The run appears under the workflow and completes, and the draft rows appear for review, unpublished.
   - The task run's input is exactly one job ID.
   - Retrying the upload's start, or a second sweep pass, does not create a second run or duplicate rows.
   - In a local or isolated test deployment, omit `RENDER_WORKFLOW_SLUG` and confirm runs use `web-process` without a warning. Test start failures with the mocked failure tests; confirm the logged failure, queued job and retry behavior. Do not change shared service runtime settings to run this failure check.

Live API behaviour found on 11 November 2026 and handled in the CI scripts: `POST /v1/workflowversions` answers 201 (the reference says 202); an empty version or task list is a JSON `null`; task registrations can appear a few seconds after a version reports `ready`.

Known limit of the release check: Render's documented workflow-version API accepts the commit on release but does not return a version ID or expose the commit on version records. The script snapshots existing version IDs, then accepts only one newly-created version belonging to the configured workflow; if multiple appear, it fails and asks the operator to check the Dashboard and retry without another release in progress. It verifies the commit through a revision marker task generated from the workflow build's checked-out SHA and only accepts the marker when registered to the selected version. Task registration is queried by that version ID. The hosted marker behavior was observed on 11 November 2026: versions for `27054c4` and `a4ba909` registered their own `revision_<SHA>` tasks.

### Rollback

Dispatch was turned off this way at 17:31 UTC on 11 November 2026, see the next section.

- Remove `RENDER_WORKFLOW_SLUG` from the web service and redeploy through CI. Imports go back to the web process, and jobs stay in PostgreSQL.
- Clear `RENDER_WORKFLOW_ID` in the GitHub Environment so CI stops syncing and releasing the workflow.
- Revoke the runtime key. Suspend or delete the workflow only after no run is in progress.

### Freeze

The workflow's own auto-deploy is off. Setting the repository Actions variable `AGENTSHELF_DEPLOY_FROZEN=true` skips the CI deploy job for both the web service and the workflow, while validation continues. It does not cancel a running deploy or block direct operator requests. Record the commit of both, which should be the same.

## Hosted run, 11 November 2026

Times are UTC.

| Item | Value |
| --- | --- |
| Workflow | `agentshelf-import`, ID `wfl-dbq98bt9fdbs73domkcg`, Frankfurt, Node, auto-deploy off, created through the Render API |
| Discarded attempt | A first workflow made with `render workflows create` was deleted before any run. The CLI and the create response reported `oregon`; the GET readback is authoritative and showed `frankfurt` for the kept workflow |
| Workflow env | `NODE_VERSION`, `DATABASE_URL` (internal URL of the existing database), and the three `AGENT_SHELF_AI_PROVIDER*` settings synced by CI |
| CI run | 43067171628, push of `a4ba909`: web deploy live at `a4ba909` with health and readiness passing. Workflow version `wfv-dbqaaoegekts73et54fg` became `ready` and registered `extractPriceList` and `revision_a4ba9095937dfa3b77c914f086e88665c544a8c3`. The job then failed on the registration race, fixed in `47009e6`. Version `wfv-dbqa6hm1egvs73d1ehvg` for `27054c4` registered its revision marker too |
| CI script fixes | `27054c4`, `a4ba909`, `47009e6`: workflow env-var path, JSON `null` lists, 201 status, registration delay, 40-minute job timeout |
| Dispatch settings | `RENDER_WORKFLOW_SLUG=agentshelf-import` and a dedicated runtime `RENDER_API_KEY` created by the owner, set on the web service |
| Upload | One synthetic photo, `test/fixtures/price-lists/phone-workshop.png`, through the seller UI to the test shop Sandbox Second Workshop at 17:29:26 |
| Import job | `783b601a-8ed5-48e1-80f9-be030ae6e801` |
| Task run | `trn-0854gdbqabtsr449g00eadvu0` on task `tsk-dbqabb4rah8g00djc5t0` (`extractPriceList` of version `a4ba909`). Input exactly `["783b601a-8ed5-48e1-80f9-be030ae6e801"]`. One attempt, 17:29:30 to 17:29:59, status `completed`, result `[{"outcome":"needs_review","rowCount":7}]` |
| Web log | `Import run started` with `runner: 'render-workflow'` and the task run ID. No `web-process`, `not reachable` or `start failed` lines |
| Result | 7 draft rows read by `gpt-6-astra` (prompt `price-list-v1`), status `needs_review`, `publishedCount` 0 |
| Repeated dispatch | `POST /v1/task-runs` with the same task, input and idempotency key `<job ID>:<createdAt ms>` returned the same run `trn-0854gdbqabtsr449g00eadvu0` (HTTP 202, status `completed`). The workflow still had exactly one run, and the rows stayed 7 after a sweep pass |

Dispatch was turned off at 17:31. `RENDER_WORKFLOW_SLUG` and the runtime `RENDER_API_KEY` were removed from the web service, because Render has no spending cap for workflow runs and the app has no run quota. Photos are read in the web process again after the next deploy. The workflow and `RENDER_WORKFLOW_ID` remain, idle: no runs, no compute cost. To enable it again, set the two web settings and deploy through CI. The owner revokes the unused runtime key in the Render account settings.

## Cost

Task runs are billed per second of compute on the `flex` plan by default, and their arguments and results are stored for 30 days ([Limits and Pricing](https://render.com/docs/workflows-limits)). A run here passes only a job ID, so stored state is negligible. The one hosted run took about 29 seconds on `flex`, which Render prices at up to $0.40 per hour; state is $0.25 per GB-month and builds use pipeline minutes. No invoice amount is recorded here. Estimates and the approval state are tracked in [#56](https://github.com/ever-guild/AgentShelf/issues/56).

## Local development

```bash
render workflows dev -- npx tsx workflows/main.ts
render workflows tasks list --local
```

To start runs from a local web server, set `RENDER_USE_LOCAL_DEV=true` and `RENDER_WORKFLOW_SLUG` in `.env.local`, and point the task server at your own disposable database ([Render local development](https://render.com/docs/workflows-local-development)).
