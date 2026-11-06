# Collaboration: deliver small verified changes

## Working agreement

Deliver one reviewable result at a time and keep colleagues informed through the issue that owns the work

Use the repository's existing direct-to-main workflow, each commit references its issue and describes the behavior actually delivered, an isolated module can be committed before its complete feature is ready

## Before changing code

- Fetch main and read the current issue, assignee and native Relationships
- Record the intended files, service contracts and acceptance slice in the issue before overlapping another contributor's area
- Keep parallel workers in separate worktrees, preserve existing edits and incoming commits
- Treat a dependency as a completion gate, independent contracts, tests and modules can progress before the whole feature is ready

## Commit and publish cadence

- Commit a coherent, tested slice when it is ready, do not accumulate completed slices until the end of a session or the whole issue
- Keep unrelated fixes, tooling and feature modules in separate commits with a Conventional Commits summary and a `Refs` trailer
- During active work, post a progress update after each published slice and before a handoff or pause, include the concrete blocker when no publishable result is ready
- Within one parallel-agent run, one integrator serializes publication to main, other contributors remain free to publish their own work through the same repository checks
- Fetch again immediately before integration and publication, if main moved, reconcile the new changes and repeat checks affected by them
- Never force-push the shared branch, discard another contributor's work, bypass hooks or publish a failing build to meet a cadence
- Run the repository's required lint, tests against disposable PostgreSQL and production build before push, verify the resulting GitHub CI run

A passing module test is evidence for that module, it does not establish a working route, browser flow, external MCP client or real PayPal payment

## Progress comments

Each published slice should record:

- Commit link and the behavior added or fixed
- Checks actually run and any relevant limitation
- Remaining acceptance criteria and next integration step
- Ownership or external dependency requiring coordination

Keep issues open until their acceptance criteria pass, use `Refs` instead of `Closes` for partial implementation, native Relationships and the Dependencies section must remain consistent

## Shared integration points

Seller identity, agent permissions, catalog operations, stock reservations and PayPal merchant connections use shared service contracts

Before changing a service owned by another contributor, identify the exact adapter, migration or behavior change and coordinate it in the relevant issue, importing an existing service is not a reason to duplicate its business logic

Do not silently activate draft migrations, switch existing seller sessions, replace buyer MCP or change capture policy while delivering an isolated module

Missing sandbox credentials block real provider evidence, they do not block tested offline tooling, contracts or independent modules, state those results separately

## Delivery evidence

A local file is not a commit, a local commit is not a published result, and a successful push is not a verified deployment

For changes delivered through main, distinguish local validation, published commit, GitHub CI and the Render deployment result, retain the exact revision used for a demo
