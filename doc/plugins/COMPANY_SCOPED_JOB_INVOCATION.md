# Scheduled jobs have no company invocation scope

Status: design note for a narrow fix, written while debugging
`paperclip-plugin-agent-usage` (a company-agnostic, instance-scoped plugin)
against this fork at `origin/master` commit
`8540ce2973204a8938cd05ac18fbc37c6434f8f5`. Also reproduced on
`paperclipai/paperclip` `upstream/master` commit
`42d0ddcb86297fa3adc2413bf9655092b9f4b1d6` (2026-08-03) — not a fork
regression, worth an upstream PR.

## The gap

`server/src/services/plugin-worker-manager.ts`'s `deriveInvocationScope()`
populates a company-scoped invocation context for three worker→host call
triggers:

- `performAction`, from `params.actorContext.companyId`
- `executeTool`, from `params.runContext.companyId`
- `onEvent`, from `params.event.companyId`

plus a generic top-level `params.companyId` check that applies regardless of
method name.

**`runJob` has no case at all.** `plugin-job-scheduler.ts`'s `dispatchJob()`
calls:

```ts
await workerManager.call(
  pluginId,
  "runJob",
  { job: { jobKey, runId, trigger: "schedule", scheduledAt } },
  jobTimeoutMs,
);
```

with no `companyId` anywhere in `params`. Any host RPC handler that requires
company scope — `config.get` in `@paperclipai/plugin-sdk`'s
`host-client-factory.js` is the one that surfaced this, via
`resolveRequiredCompanyId()`, which unconditionally requires
`context.invocationScope.companyId` to be set — is therefore **uncallable
from inside a scheduled job**, full stop, for any plugin, regardless of what
the plugin's own manifest or worker code does. This is not something a
plugin author can work around from their side.

PLUGIN_SPEC.md §17 ("Scheduled Jobs") documents job rules (stable `job_key`,
host-is-scheduler-of-record, no overlapping runs, every run recorded,
retryable) but says nothing about company scope — this doc fills that gap
until the spec catches up.

## Evidence the schema anticipated this

`packages/db/src/schema/plugin_jobs.ts` — `plugin_job_runs.companyId`:

```ts
/** Company scope — NULL for instance-level jobs. */
companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
```

This column already exists, is indexed (`plugin_job_runs_company_idx`), and
is simply never populated by `dispatchJob()` today.

## Two possible fixes

### A. Narrow (implemented) — resolve one company for the existing run

For jobs that don't need per-company fan-out (the common case: a plugin
polling one shared external resource — one Claude subscription, one Slack
workspace, whatever — where the *result* is instance-wide even though the
RPC plumbing requires *some* company scope to authorize `config.get`, etc.),
resolve one accessible company at dispatch time and attach it:

- Add `companyId` to the `runJob` params sent to the worker (satisfies the
  existing generic top-level check in `deriveInvocationScope` — no change
  needed there).
- Pass the same `companyId` into `jobStore.createRun(...)` — the column
  already exists and is already indexed.
- Company resolution: pick the first company visible via whatever query
  `companies.list` already uses server-side, or (better, once available)
  let the plugin declare a "home company" alongside its instance-wide
  install, defaulting to first-active if unset. **This implementation just
  uses first-active for now** — see the actual diff for exact resolution
  logic.

This is additive and changes behavior only for plugins whose scheduled job
calls a company-gated host method — plugins that don't call anything
company-gated from their job handler are unaffected either way, since
`deriveInvocationScope` returning a scope that nothing checks is a no-op.

### B. Broad (not implemented) — real per-company fan-out

For plugins that need genuinely separate per-company results (e.g. per-
company API accounts, not one shared resource), `dispatchJob()`'s tick loop
would need to:

1. Learn (via a new field on `PluginJobDeclaration` in
   `packages/shared/src/types/plugin.ts` — something like
   `scopeKind: "instance" | "company"`, default `"instance"` for full
   backward compat) whether a job wants per-company dispatch.
2. Enumerate accessible companies for that plugin.
3. Call `runJob` once per company, each with its own `companyId` and its own
   `plugin_job_runs` row — the schema already supports N rows per tick per
   job, there's no dedup constraint against it.
4. `packages/plugins/sdk/src/protocol.ts`'s `PluginJobContext` would need a
   `companyId` field so the worker knows which company a given invocation is
   for (mirroring `ToolRunContext.companyId`, `PluginPerformActionActorContext.companyId`).

This is real new surface area (manifest schema, SDK protocol, scheduler fan-
out logic, `activeJobs` overlap-guard needs to become per (jobId, companyId)
rather than per jobId) — worth doing only when a real plugin needs it. Not
built here; `paperclip-plugin-agent-usage` doesn't need it (see its
`backlog/company-scoped-config_research.md` for why).

## What ships in this fork now

Option A only. See the PR that references this doc for the actual diff.
