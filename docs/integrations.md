# Partner integrations

Evidence for [#3](https://github.com/ever-guild/AgentShelf/issues/3).

Checked on 2026-11-05 with `next` 16.4.5, `react` 19.3.0, Node 24.15.0 and npm 11.12.1 on macOS arm64. Updated on 2026-11-06 with the deployment, APIMatic, catalog import, schedule and dashboard results.

**Render hosts the application, and the APIMatic skills were used while writing PayPal code. In the code but not yet run with a licence key or on Render: the AG Studio dashboard and its Claude assistant, the Bryntum 8.0 Community schedule, and the Render Workflows import task (local server only). Code tested against stand-ins is not a verified integration, so none counts as integrated until the steps in [full-run.md](full-run.md) pass.** This file records access, setup and the smallest check that could run without an account.

- **Ran:** the step was executed. Clean installs used new empty directories, an empty npm config and a fresh cache, so no login was in play. Checks used small throwaway probes outside this repo, with `next build`, `next start` and a real browser.
- **Read:** taken from vendor docs or shipped package code, not exercised.

## Capability table

| Partner | Package or service | Setup path | Access status | Minimal verification | Trial expiry and renewal risk | Public repo and hosted demo |
| --- | --- | --- | --- | --- | --- | --- |
| AG Studio | `ag-studio-react`, `ag-studio` 3.1.0. Public npm, Commercial. Pulls `ag-grid-enterprise` 36.3.0, `ag-charts-enterprise` 14.3.0 | `npm install ag-studio-react ag-studio`, no registry login. Trial key from a web form | Install **PASS**. Trial key **BLOCKED**, owner action 2 | Without a key **PASS** (ran): build, render, custom theme, custom widget reading an aggregate. With a key **BLOCKED** | 45 days from request (read). A key requested on Nov 5 ends Dec 20, one day short. At expiry: watermark and console errors, no lock (read in shipped code) | Dependency only, never vendored. Key in an env var, and it reaches the browser. Trial terms **INCONCLUSIVE**, owner action 7 |
| Studio Agent Framework | Included in `ag-studio` 3.1.0: `AgStudioAiModule`, `createAiHarness`. No separate package | Register the module, supply an `AgLlmAdapter`, keep the model key behind a server route | Module **PASS**. Real model **PASS**, through our Claude adapter, no Studio key | **PASS** without a Studio key on a production build: [real run](architecture.md#demand-insights-and-the-assistant). With a key **BLOCKED**, owner action 2 | Same key as AG Studio, and the key must cover AI (read) | Model key stays on the server. Same trial terms question |
| Bryntum Scheduler | 8.0.0 tier packages on public npm. Devpost still names the 7.3.8 trial | See [tracks](#bryntum-scheduler). No registry login | Install **PASS** on every track. Track choice is owner action 3 | 8.0 Community **PASS**, 8.0 Business without a key **PASS**, 7.3.8 trial **PASS**, `@bryntum/scheduler@latest` **FAIL** (all ran) | Community: none. Business and 7.3.8: masked at expiry (ran) | Community is MIT, fully compatible. A Business key must not be committed (read) |
| Render Workflows | Render service, `@renderinc/sdk` 1.7.0, Render CLI 2.35.0 | `type: workflow` in `render.yaml`, TypeScript on `runtime: node` | SDK and CLI **PASS**. Deploy and credits **BLOCKED**, owner action 4 | Local task server **PASS** (ran): the import task registered, ran, retried and failed as designed. On Render **BLOCKED** | Credit expiry unknown until claimed (read). Billed by usage, no free allowance listed | `RENDER_API_KEY` in Render only, no repo impact |
| APIMatic Context Plugin | `context-plugins` 0.12.0 installs plugin `paypal` 0.1.0 from `paypaldev/server-sdk-context-plugin-preview` | One `npx` command per developer, no credentials, or the [project-level skills](paypal-agent-setup.md) from the same source | **PASS** | Install **PASS** into an isolated editor config (ran). Use while writing PayPal code **PASS**, [recorded below](#apimatic-context-plugin). It says nothing about how PayPal behaves, which is [#2](https://github.com/ever-guild/AgentShelf/issues/2) | No trial. The repo calls itself an experimental preview that may be removed (read) | Editor assistance only, nothing in the repo or at runtime |

All partner packages added to this repo's current dependencies: `npm install` and `npm ci --include=dev` **PASS** with one copy of React and no peer conflicts (ran, macOS only). Partner packages add no audit findings.

## Dates that decide trial timing

| When | What | Consequence |
| --- | --- | --- |
| Nov 12, 12:00 PST (22:00 Riga) | Submissions close. Organisers ask teams not to edit the repo, video or linked materials until winners are announced | A licence renewal must never need a commit, so keys live in env vars |
| Dec 1 to Dec 15 | Judging. Rules require free, unrestricted access until it ends | The demo must still work |
| Dec 21, 14:00 PST (Dec 22, 00:00 Riga), "on or around" | Winners announced. Organisers ask teams to keep demos, test credentials, trials and credits active until then | The real target for every expiry date |

A 45-day trial started on Nov 5 ends Dec 20, on Nov 6 ends Dec 21, on Nov 7 ends Dec 22, on Nov 10 ends Dec 25. **Request keys from Nov 7 to Nov 10**, and develop without them until then.

## AG Studio

- Install pinned: `npm install --save-exact ag-studio-react@3.1.0 ag-studio@3.1.0`. The peer range accepts React 19 (ran).
- Use from a `'use client'` component inside `<AgStudioProvider licenseKey={key}>`, in a sized parent. A server component can read `process.env.AG_STUDIO` and pass it down as a prop (ran, without a value).
- Without a key: console errors on `localhost`. On other hostnames also a "For Trial Use Only" watermark for five seconds. Everything tried worked and no licensing request left the page (ran on a `*.localhost` origin). Docs still say every deployment requires a licence, so deploy with a key.
- Key checks happen in the browser, with no server call (read in shipped code). The licence install page has a validator.
- The key covers AG Studio and its built-in widgets only. AG Grid or AG Charts Enterprise inside a custom widget needs separate licences (read), so write custom widgets in plain React or with the Community packages.
- A standalone `ag-grid-community` must match the Studio version: 36.3.0 for 3.1.0 (read).
- `AgWidgetDefinition` requires `form` (ran, TypeScript rejects it otherwise). Import `createWidgets` from `ag-studio-react`, and read data with `widgetApi.getData({ fields })`.
- The main client chunk is about 6.7 MB uncompressed, so keep it on dashboard routes (ran).
- Bundled licence clause 3.6 asks published applications to carry an AG Grid copyright notice. Add it to the README.

**Boilerplate:** [`paypaldev/hackathon-paypal-ag-grid-boilerplate`](https://github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate) is real AG Studio (read, not run): `ag-studio` and `ag-studio-react` 3.0.0 for `/dashboard`, plain `ag-grid-community` and `ag-grid-react` 36.2.0 for the endpoint pages, on `next` 16.3.6 and `react` 19.2.8. It has a custom theme and the built-in agents behind a copied OpenAI adapter. It has no custom widgets or custom agents, which the AG Grid prize page asks for, and no licence file, so use it as a reference rather than copying code. Its `ai.ts` fails type checking on 3.1.0, while its adapter and theme compile (ran `tsc`).

## Studio Agent Framework

- Register with `<AgStudioProvider modules={[AgStudioAiModule]}>`, then pass `ai={setup}` to `<AgStudio>`.
- The documented `({ api }) => createAiHarness(api, { adapter })` fails `next build` on 3.1.0: the callback's `api` is `AgCoreStudioApi` and the function wants `AgStudioApi`. Cast it with `api as AgStudioApi` (ran). 3.0.0 types differ.
- AG Studio ships no adapters. Docs give one example for the OpenAI Responses API to copy, so another provider needs its own adapter (read).
- **Decision, [#15](https://github.com/ever-guild/AgentShelf/issues/15):** the assistant uses Claude, with `ANTHROPIC_API_KEY` and `claude-opus-5-5` at low effort, through an `AgLlmAdapter` of our own in [`dashboard-assistant.ts`](../src/app/seller/dashboard/dashboard-assistant.ts). That is one vendor and one key with catalog import, and nothing is copied. `OPENAI_API_KEY` is not used.
- The adapter runs in the browser, so it talks to a seller-authenticated route that holds the key. The boilerplate's `/api/ai/responses` passes whatever the browser sends, and its README warns it has no auth or rate limiting. Ours takes only the conversation: instructions and tools are the server's, the adapter drops the ones Studio offers, and each shop has an hourly limit (ran).
- What the installed 3.1.0 has (ran): `directLlmRunner` builds an agent from an adapter, and a builder passed to `createAiHarness` returns `agents`, `primary` and `promptStarters`. A tool can be a plain `AgAiTool` object with `schema()` and `execute()`. The chat panel `"ai"` exists only in `edit` panels, and `AgPanelConfig.view` has no such type. Without a key `AgStudioAiModule` logs a licence error and says its features are unlocked for trial.
- Opus 5.5 returns 400 for a forced tool choice, so the adapter leaves that to the model. A tool round trip works with no thinking block replayed (ran).
- `AgStudioAiModule` requires licence type "AG Studio Pro with AI". A key without AI logs an incompatible licence error (read in shipped code and docs).
- Built-in agents: `lead`, `data`, `page`, `planning`, `widget` (read). Tools the lead received in the stub turn: `view_schema`, `view_report`, `view_page`, `view_plan`, `update_plan`, `clear_plan`, `rename_thread`, `delegate_to` (ran).
- Custom agents: pass a builder to `createAiHarness` that returns `agents` and `primary`. Passing a harness of your own to `ai` is also supported (read).

## Bryntum Scheduler

Bryntum 8.0 shipped on Nov 3 with tier packages, and its docs now describe 8.0. `@bryntum/scheduler` is now an empty placeholder.

| Track | Install | Licence | Visible on the page | When it stops | `timeZone` | Result (ran) |
| --- | --- | --- | --- | --- | --- | --- |
| 8.0 Community (recommended) | `npm i -E @bryntum/scheduler-react-community@8.0.0` | MIT, no key | Nothing | Never | Not available | **PASS** |
| 8.0 Business | `npm i -E @bryntum/scheduler-react-business@8.0.0` | Commercial. 14 days per browser without a key, 45 days with a key | Small corner "Trial" badge | Masked, with a "Get a trial key" notice | Accepted | **PASS** without a key |
| 7.3.8 trial (Devpost command) | `npm i @bryntum/scheduler@npm:@bryntum/scheduler-trial @bryntum/scheduler-react@7.3.8` | Commercial trial, no key | Large "Bryntum, Trial Version" watermark across the canvas | 45 days per browser from first use, then masked with no events shown | Present in types, not run | **PASS** |
| `@bryntum/scheduler@latest` (the 7.3.8 wrapper README says this) | Do not use | | | | | **FAIL**: `ERR_MODULE_NOT_FOUND`, no code in the package |

Expiry was observed by simulating elapsed time in a test browser. A trial key has a fixed end date for every visitor (read).

- **In use:** 8.0 Community, in [`schedule-timeline.tsx`](../src/app/seller/schedule/schedule-timeline.tsx). [#13](https://github.com/ever-guild/AgentShelf/issues/13) needed a track before the captain chose one, and this one has no key or expiry. See owner action 3.
- Community covers the read-only view in [#13](https://github.com/ever-guild/AgentShelf/issues/13): technicians as resources, bookings as events, a custom event renderer with status text, `readOnly` (ran). `EventTooltip` is included (read). `TimeRanges`, `NonWorkingTime`, `Labels` and `EventFilter` need Business, and AI features need Enterprise (read).
- **Time zone:** Community has no `timeZone`, and setting one has no effect (read in shipped code, ran). #13 requires Europe/Riga, so convert UTC instants to Riga wall-clock strings on the server and pass them without an offset. With a browser set to New York, every bar sat under its Riga hour (ran).
- **Next.js:** load the wrapper with `next/dynamic` and `{ ssr: false }` from a client component, because Bryntum does not support server rendering (read, ran).
- **Theme trap:** import `svalbard-light.css`, not the `svalbard.css` in the README. Next's default CSS targets rewrite `light-dark()`, and the combined theme renders unstyled (ran both).
- Also import `scheduler.css` and the Font Awesome files from `core-community` (read). Custom fields on inline events need a cast or a custom model in TypeScript (ran).
- Bryntum's guide says a key is not secret but should not be published in public repositories (read). A Business key therefore goes in an env var, set in a client component as `bryntum.licenseKey` (read, not run).

## Render Workflows

**Availability:** the docs list it with no beta label, TypeScript and Python only (read). A TypeScript workflow uses `runtime: node`. Limits are listed for Hobby workspaces, which have no monthly fee.

**Submit, from the web service:**

```ts
import { Render } from '@renderinc/sdk';

const render = new Render(); // reads RENDER_API_KEY
const run = await render.workflows.startTask(`${workflowSlug}/extractPriceList`, [importJobId], {
  idempotencyKey: importJobId,
});
// store run.taskRunId on the import job
```

**Retrieve:** `await run.get()` waits for the end of the run, and `render.workflows.getTaskRun(id)` reads it later. Fields: `status`, `results` (an array, the return value is `results[0]`), `error`, `attempts`, `retries` (ran). Treat `completed` and `succeeded` as success: the local server returned `completed`, and the SDK types mark it deprecated in favour of `succeeded`. `failed` and `canceled` are also terminal.

**Define a task:**

```ts
import { task, type TaskContext } from '@renderinc/sdk/workflows';

task(
  { name: 'extractPriceList', retry: { maxRetries: 2, waitDurationMs: 500, backoffScaling: 1.5 }, timeoutSeconds: 300 },
  async function extractPriceList(_ctx: TaskContext, importJobId: string) {
    // load the job, call the model, write rows to Postgres
  },
);
```

**Blueprint** (read; validating it needs a workspace):

```yaml
  - type: workflow
    name: agentshelf-import
    runtime: node
    region: frankfurt
    buildCommand: npm ci --include=dev
    startCommand: node workflows/main.ts
```

`region` is required. `plan` is not allowed because compute is set per task in code. `previews` and `preDeployCommand` are not supported. The web service can read the slug with `fromService` and `property: slug`.

**Constraints for [#8](https://github.com/ever-guild/AgentShelf/issues/8)** (read):

- Arguments and return values are limited to 4 MB each, so pass a job ID rather than image bytes.
- Idempotency keys only prevent duplicate root runs, for 24 hours and within one workflow version, and retries still re-execute. Keep the database uniqueness rule.
- Runs accept no inbound connections, but reach Postgres over the private network in the same region.
- Pricing: `flex` plan at $0.20 per CPU-hour and $0.05 per GB-hour, plus $0.25 per GB for input and output retained 30 days. Hobby allows 50 root run requests per minute.

**Local development** (ran, no login and no API key):

- Get CLI 2.35.0 or later, then run `render workflows dev --port 8131 -- node src/main.ts`. Leave the command unquoted: the quoted form in `--help` fails with a `fork/exec` error.
- Set `RENDER_USE_LOCAL_DEV=true` and `RENDER_LOCAL_DEV_URL` for the SDK. Node 24 runs the TypeScript directly, so `tsx` is optional.
- `render workflows init` pins `@renderinc/sdk` 1.0.0, while the docs require `^1.7.0`. Bump it.
- The local server does not match Render: a repeated idempotency key started a second run, and a 5 MB argument was accepted. An early probe also saw `maxRetries` ignored, but the import task made 3 attempts with `maxRetries: 2` (ran). Verify these on Render.
- **The import task on the local server** (ran, against a stand-in for the Claude API): a photo uploaded to a production build ran as a task and reached review. Delivering the same job again returned `skipped` with no model call. With the stand-in answering `529`, the task made 3 attempts and recorded the failure on the job.

**Hosting limits for the demo** (read, relevant to [#4](https://github.com/ever-guild/AgentShelf/issues/4)):

- [deployment.md](deployment.md) covers the free plan limits and the plan decision.
- Both paid plans it names fit the $50 credit through December if the credit lasts. A Hobby workspace allows one team member. Pro adds $25 per month and would use up the credit.

## APIMatic Context Plugin

- **What it is:** agent skills, eight per language for six languages, grounded in the generated `@paypal/paypal-server-sdk`. No hooks and no MCP server (ran, inspected the installed plugin).
- **Install, per developer:** `npx context-plugins install https://github.com/paypaldev/server-sdk-context-plugin-preview --targets claude`, then restart the editor. `--targets` also takes `cursor`, `vscode`, `codex` or `all`. The installer's README also offers `npx context-plugins install paypal` (not run).
- **The `claude` target:** needs `claude` on `PATH`, and the plugin installs at user scope, so it changes editor config rather than this repo (ran). The other targets were not tested.
- **Runtime:** none. Set `DO_NOT_TRACK=1` to turn off installer telemetry.
- **Scope:** the plugin covers only `@paypal/paypal-server-sdk` 2.5.0, with no mention of `@paypal/agent-toolkit` or the JS SDK v6 (ran, searched its files). Orders code uses that SDK, whose `PurchaseUnitRequest` exposes `payee` (ran, read its types), so the guidance applies there. Work on the other two needs other sources.
- **Actual use:** the [sandbox proof](paypal-sandbox-proof.md#other-paypal-capabilities) and the [checkout service](../src/server/paypal/orders.ts) were written with the skills. In the checkout service they led to these decisions:
  - An explicit 12-second timeout, because the SDK's generated default is no limit at all.
  - Explicit retry settings, because retrying takes two fields together and a repeated `POST` has to be idempotent.
  - Reading failures by status code, `debug_id` and issue name, because `OAuthProviderError` is shadowed by an enum of the same name at the package root, so `instanceof` cannot use it, and because error payloads keep PayPal's own field names.
  - Tests through the transport adapter, so that they run the real SDK.
  - One long-lived client per seller app, to reuse its token. Reading the runtime behind that advice showed that one failed token exchange would then stop every later call, so the provider replaces a client after a failure.
  - Verifying webhooks through the client's public request builder, because the SDK has no webhook API, so that call shares the same token, timeout and test adapter.
- **Evidence:** the APIMatic claim form asks for a project or repo link showing plugin usage and a short description, and is manually reviewed (read). The list above is that description. The claim has not been filed.

## Environment variables

[`.env.example`](../.env.example) lists these names with no value. Names marked proposed are not vendor-defined.

| Name | Where | Purpose |
| --- | --- | --- |
| `AG_STUDIO` | Render web service, `.env.local` | AG Studio licence key, the boilerplate's name. Reaches the browser, never commit it |
| `ANTHROPIC_API_KEY` | Render web service and workflow, `.env.local` | Reads price list photos and suggests descriptions |
| `NEXT_PUBLIC_BRYNTUM_LICENSE_KEY` (proposed) | Render build, `.env.local` | Only on the Business track. Inlined at build time |
| `RENDER_API_KEY` | Render web service | Starts and reads task runs. Secret, created under Account Settings |
| `RENDER_WORKFLOW_SLUG` (proposed) | Render web service | Prefix for task slugs |
| `RENDER_USE_LOCAL_DEV`, `RENDER_LOCAL_DEV_URL` | `.env.local` only | Point the SDK at the local task server |

## Owner actions

1. **Devpost representative ([#7](https://github.com/ever-guild/AgentShelf/issues/7)):** submitted for the early eligibility check on Nov 5, according to the representative. The confirmation on Devpost was not checked.
2. **Nov 7 to Nov 10, AG Studio owner:** request the trial key with the form (email, first name, last name). Check with the validator that it covers AI. Set `AG_STUDIO` in Render and `.env.local`, and record the expiry date here, never the key. Ask AG Grid via the PayPal Discord if the key does not cover AI.
3. **Team captain:** the schedule is built on 8.0 Community, which has no expiry or watermark, but needs Riga wall-clock strings and lacks Business features. Overrule this if Business is wanted, a scope decision, and request a key from Nov 7 to Nov 10 at bryntum.com/download.
4. **Render account owner:** sign in to the [credits portal](https://credits-portal-mmdm.onrender.com/claim/paypal-ai-hackathon) with GitHub and apply the code under Billing, Credit Balance in the right workspace. Credits do not transfer between workspaces. Record the credit expiry here. The web service and database already exist outside a Blueprint, as [deployment.md](deployment.md#existing-deployment) explains, so do not create a second stack. Run `render blueprints validate`, create `RENDER_API_KEY`, and deploy one task to confirm the slug, retries and idempotency.
5. **Owner of [#4](https://github.com/ever-guild/AgentShelf/issues/4):** decide on the paid plans before Nov 12, as [deployment.md](deployment.md) explains. Licence keys cannot meet the "no secret in client bundles" check, so that check should exclude them.
6. **Team captain:** catalog import uses Claude, recorded in [#8](https://github.com/ever-guild/AgentShelf/issues/8), and one adapter file holds that choice. Confirm it, or say otherwise. [#15](https://github.com/ever-guild/AgentShelf/issues/15) chose Claude for the Agent Framework too, recorded above.
7. **PayPal Discord, AG Grid and Bryntum teams:** the bundled licences limit a trial to "internal evaluation and review purposes" (clause 13), while the Devpost pages invite teams to build on the trial and the rules require authorised use. AG Grid's [enterprise licence page](https://www.ag-grid.com/studio/react/enterprise-licence/) does allow a trial in a production environment, which does not settle the bundled clause. Ask for written confirmation that a public repo and hosted demo on a trial are fine, and that 8.0 Community qualifies for the Bryntum prize.
8. **APIMatic claim owner:** file the claim form with the repository link and the description under [APIMatic Context Plugin](#apimatic-context-plugin).

## Not verified

- AG Studio and Bryntum behaviour with a real key, and AG Studio behaviour with an expired key.
- On Render: Blueprint validation, hosted task runs, retries, idempotency, credit terms, whether a payment method is required. The deployment itself is verified in [#31](https://github.com/ever-guild/AgentShelf/issues/31).
- A real model reading a real photo. The smoke check in [deployment.md](deployment.md#render-workflows-for-photo-import) does this once a key is set.
- Builds on Linux with the partner packages. The repository's own build runs on Linux in CI.
- The Devpost submission form and the PayPal Discord, both of which need a login.

## Sources

- Devpost: [AG Grid](https://paypalaihackathon.devpost.com/details/aggrid), [Bryntum](https://paypalaihackathon.devpost.com/details/bryntum), [Render](https://paypalaihackathon.devpost.com/details/render), [APIMatic](https://paypalaihackathon.devpost.com/details/apimatic), [rules](https://paypalaihackathon.devpost.com/rules), [early review update](https://paypalaihackathon.devpost.com/updates/47305-two-weeks-to-go-get-your-project-checked-early), [submission checklist update](https://paypalaihackathon.devpost.com/updates/47307-submission-checklist-it-s-go-time), [judging update](https://paypalaihackathon.devpost.com/updates/47306-lights-camera-paypal-video-tips-and-how-judging-works)
- AG Studio: [quick start](https://www.ag-grid.com/studio/react/quick-start/), [enterprise licence](https://www.ag-grid.com/studio/react/enterprise-licence/), [licence install](https://www.ag-grid.com/studio/react/licence-install/), [compatibility](https://www.ag-grid.com/studio/react/compatibility/), [custom widgets](https://www.ag-grid.com/studio/react/custom-widgets/), [agents](https://www.ag-grid.com/studio/react/ai-agents/), [agent quick start](https://www.ag-grid.com/studio/react/ai-quickstart/), [Direct LLM Runner](https://www.ag-grid.com/studio/react/ai-direct-llm-runner/), [licence text](https://www.ag-grid.com/studio/licenses/ag-studio/LICENSE.html)
- Bryntum: [licensing](https://bryntum.com/docs/guide/Core/licensing), [features per tier](https://bryntum.com/docs/guide/Scheduler/basics/feature-availability), [Next.js quick start](https://bryntum.com/docs/guide/Scheduler/quick-start/nextjs), [React guide](https://bryntum.com/docs/guide/Scheduler/integration/react/guide), [download](https://bryntum.com/download/), [licence](https://bryntum.com/products/license/)
- Render: [Workflows](https://render.com/docs/workflows), [tutorial](https://render.com/docs/workflows-tutorial), [triggering runs](https://render.com/docs/workflows-running), [local development](https://render.com/docs/workflows-local-development), [limits and pricing](https://render.com/docs/workflows-limits), [TypeScript SDK](https://render.com/docs/workflows-sdk-typescript), [Blueprint reference](https://render.com/docs/blueprint-spec), [free instances](https://render.com/docs/free), [plans](https://render.com/docs/platform-features-by-plan), [credits](https://render.com/docs/credits), [pricing](https://render.com/pricing), [CLI releases](https://github.com/render-oss/cli/releases)
- APIMatic: [Context Plugins](https://www.apimatic.io/product/context-plugins), [getting started PDF](https://drive.google.com/file/d/1qa7Xkjt3PGJllHQVCP1IuE-XxlRNz4mN/view), [plugin repo](https://github.com/paypaldev/server-sdk-context-plugin-preview), [installer](https://github.com/apimatic/context-plugins-installer), [claim form](https://docs.google.com/forms/d/e/1FAIpQLScc2oCgAFACm7d6H3R4mgzv-O34DdyVnLIBNiwmUNggr_-hhA/viewform)
