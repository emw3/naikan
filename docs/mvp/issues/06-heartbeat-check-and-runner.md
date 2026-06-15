# 06 — HeartbeatCheck CRUD + `heartbeat-runner` (manual-trigger end-to-end)

Status: ready-for-human
Category: enhancement
Type: AFK

## Parent

`docs/mvp/PRD.md`

## What to build

HeartbeatCheck entity + CRUD UI, the `heartbeat-runner` module, and a "Run now" button in the admin UI that synchronously invokes the runner and displays the result. No scheduler yet (lands in #07).

`HeartbeatCheck`: `site_id`, `path`, optional `body_assertion` (regex or JSON path), `cert_check` (bool), `dns_check` (bool), `interval_seconds`, `alert_after_n_fails`. Group inheritance not in scope here — direct values only; inheritance is bolted on in #08.

`heartbeat-runner` is a pure executor: takes a HeartbeatCheck config, returns a CheckRun result (status, latency, error). Internally wraps HTTP fetch, DNS resolution, SSL cert inspection, and body assertion.

End-to-end demo: admin defines a heartbeat check pointing at a known-good URL, clicks Run, sees success + latency. Points at a 500 URL, sees fail + error.

## Acceptance criteria

- [x] `HeartbeatCheck` and `CheckRun(id, check_id, check_type, started_at, finished_at, status, latency_ms, error?, artifacts_ref?)` migrations applied
- [x] `heartbeat-runner` module implements: HTTP fetch w/ status check, body assertion (regex + JSON path), DNS resolution, SSL cert expiry inspection
- [x] Admin UI: create/edit/delete heartbeat check under a site; "Run now" button
- [x] Run-now path invokes `heartbeat-runner` synchronously, writes `CheckRun`, returns result to UI
- [x] Unit tests on `heartbeat-runner` covering all 4 signal types, against a local HTTP mock + DNS stub + cert stub
- [x] Integration test: create check via API → run-now → CheckRun row written

## Blocked by

- #05

## Implementation notes

- `HeartbeatCheck` CRUD + the `CheckRun` store live in `@naikan/config-repo` (per its
  doctrine as the single DB-access path for check entities); audit log widened to cover
  the `heartbeat_check` entity type.
- The runner is a separate pure-compute package, `@naikan/heartbeat-runner`, with
  injectable `fetch`/DNS/cert/clock deps (live Node/Bun defaults). Signals run
  independently and all failures aggregate into one error string.
- `CheckRun.check_id` is intentionally not a FK — runs are polymorphic over check types
  (`check_type` discriminates heartbeat vs the uicheck arriving in #11).
- Run-now is admin-gated (it triggers external requests + writes a run). The API accepts
  an injected runner so the integration test stays network-free.
- UI: new `#/sites/:id` route (`SiteDetail.svelte`) with check CRUD + per-check Run-now
  showing pass/fail + latency; site rows in the project view link into it.
- Migration `1800000000000_heartbeat-checks.js` is written but not applied here (no DB in
  the dev sandbox); it mirrors the proven #05 migration shape.
