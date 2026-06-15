# 07 — Scheduler + graphile-worker queue

Status: ready-for-human
Category: enhancement
Type: AFK

## Parent

`docs/mvp/PRD.md`

## What to build

Install graphile-worker, run it as a separate `worker` process consuming jobs from Postgres. Implement the `scheduler` module as a pure function: input = list of check configs + current time + per-check `last_run_at`, output = list of jobs to enqueue. A periodic "tick" (every 30s) calls `scheduler.nextRunsFor(now, configs)` and enqueues the resulting jobs; the worker consumes them and invokes `heartbeat-runner`.

End-to-end demo: an admin creates a heartbeat check with `interval_seconds=60`, observes that without clicking Run-now the CheckRun history fills up with one row per minute.

## Acceptance criteria

- [x] graphile-worker installed; worker process boots, registers job handlers, picks up tasks from Postgres
- [x] `scheduler` module is a pure function — no clock or DB injected directly, both passed as args
- [x] Tick process enqueues heartbeat-run jobs based on `scheduler.nextRunsFor`
- [x] Worker job handler invokes `heartbeat-runner`, writes `CheckRun`, no scheduling logic in the handler itself
- [x] Unit tests on `scheduler`: simple intervals, missed-tick catch-up, multiple checks with different intervals
- [x] Integration test: insert a HeartbeatCheck, advance time (injected clock) twice, assert two CheckRuns written
- [x] Worker process documented in README + `docker-compose` and runnable separately from the API

## Blocked by

- #06

## Comments

**Implemented (agent, 2026-06-02).** Branch `worktree-issue-07-scheduler-queue`.

- `@naikan/scheduler` — pure `nextRunsFor(now, entries)` (no clock/DB injected). 8 unit
  tests: simple intervals, interval boundary, missed-tick catch-up (one job, not back-filled),
  multiple checks with different intervals, clock-skew.
- `config-repo` — added `listAllChecks()` (store `checks.listAll`, in-memory + pg) so the tick
  can schedule across all sites. +2 tests.
- `apps/worker` — `runTick({now,repo,enqueue})` derives `last_run_at` from the latest CheckRun
  and enqueues via `nextRunsFor`; `runHeartbeatJob(checkId,{repo,runCheck})` runs the check and
  writes a CheckRun with **no scheduling logic**. `src/index.ts` is the Node bootstrap
  (graphile-worker `run` + `makeWorkerUtils.addJob` with per-check `jobKey` dedupe + 30s tick +
  graceful shutdown). 6 integration tests, incl. the required "advance clock twice → two
  CheckRuns" (in-memory queue, no graphile-worker needed for the scheduling proof).
- Docs: README "Worker & scheduler" section + `docker-compose.yml` `worker` + `postgres` services.
- Worker runs on **Node** per ADR-0001 (`start` = `node src/index.ts`); verified Node 22.19
  strip-types imports the `.ts` kernel packages with no build step.

Verification: `bun test` → **135 pass / 0 fail** (6 pre-existing DB-gated skips); `bun run
typecheck` (web-admin) → 0 errors; `bun build` of `index.ts` resolves cleanly.

**Two criteria marked `[~]` (blocked only by no network in the build env):**
the agent box can't reach the npm registry, so `graphile-worker` (+ `@types/node`) could not be
fetched and `bun.lock` was not regenerated. Before merge, on a networked machine:

1. `bun install` — fetches `graphile-worker@^0.16.6` + `@types/node`, refreshes `bun.lock`
   (CI uses `--frozen-lockfile`, so this is required for CI to pass).
2. Smoke the live boot: `bun migrate` then `bun run --cwd apps/worker start` against Postgres;
   create a check with `interval_seconds=60` and confirm CheckRuns accrue ~1/min without Run-now.

All scheduling/handler logic is fully tested offline; only the live graphile-worker transport
boot remains to confirm.

**Live boot verified (agent, 2026-06-02).** Once the registry was reachable, `bun install`
pulled `graphile-worker@0.16.6` (+`@types/node`) and refreshed `bun.lock`. Booted the full
stack — compose Postgres → `bun migrate` → seed admin → API → `bun run --cwd apps/worker start`
(Node 22.19) — created a check with `interval_seconds=60`, and **without Run-now** `check_runs`
accrued 1 → 2 → 3 (~1/min). Worker logs: `Worker connected … (task names: 'heartbeat-run')`,
`tick: enqueued 1 heartbeat job(s)`, `Completed task N (heartbeat-run) with success`.

One fix landed during boot: Node's strip-only TS loader rejects **parameter properties**, which
`config-repo` used in `ValidationError` and `InMemoryConfigStore`. Rewrote both to explicit field
assignment (behaviour-identical; Bun was lenient, Node is not) — this is now an ADR-0005
constraint for kernel packages. All 135 tests still pass. Both criteria above flipped to `[x]`.
