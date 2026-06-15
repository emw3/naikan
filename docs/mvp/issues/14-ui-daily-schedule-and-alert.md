# 14 — UI daily scheduling + realtime alert on load=critical

Status: ready-for-human
Category: enhancement
Type: AFK

## Parent

`docs/mvp/PRD.md`

## What to build

Have the scheduler enqueue UICheck runs on the configured daily cadence (default once per day, per-project/per-check override allowed). Wire UICheck failures to the alerter using the same severity tiering as heartbeats: any signal with severity=critical that fails triggers a realtime alert via the same `alerter.dispatch` path; warnings do not.

By default this means: only `load=critical` failures alert realtime — visual regression / console / selector / perf default to warning and stay in the daily digest.

Reuse `incident-machine` for UI checks: any critical signal failure is treated equivalently to a heartbeat fail for purposes of incident open/close. (UI incidents close after 2 consecutive UICheck successes — daily cadence means ~48 hours to recovery alert, document this trade-off.)

End-to-end demo: a UI check with `load=critical` runs daily; deliberately point it at a 500 URL; an incident opens and an alert is sent; restore the URL; after 2 successful daily runs the incident closes with duration.

## Acceptance criteria

- [x] Scheduler emits UICheck-run jobs at configured cadence
- [x] UICheck CheckRun feeds the same `incident-machine` path as heartbeats, gated on critical-signal failure
- [x] Alerter messaging covers UI alerts (subject/body templates per check type)
- [x] Per-check cadence override stored on UICheck (default once daily)
- [x] Integration test: scheduler tick → UICheck enqueued → ui-runner load fails → incident opened → alert dispatched (via fake)

## Implementation notes

- **Incident model resolved (Path A).** Issue text predated CONTEXT.md:39 / PRD L109, which had said UI signal failures do *not* open Incidents. Confirmed with the maintainer: reuse `incident-machine` for UI (this issue), and CONTEXT.md + PRD updated to match (a `critical` UI signal now opens an Incident).
- **`critical_failed` seam.** `CheckRun.status` keeps its PRD-L110 meaning ("any signal/regression failed", for the digest); a new nullable `check_runs.critical_failed` carries the incident signal (did a `critical`-severity Signal fail?). The UI orchestrator reads `critical_failed`, not `status` — so a warning-only failure (or a visual regression) fails the run for the digest without paging. Migration `1850000000000_ui-schedule-and-critical-fail.js`.
- **UI N-fails fixed at 1** (`UI_ALERT_AFTER_N_FAILS`): UI pages on the first critical fail ("any critical signal failure"). Only the cadence inherits (check → group → daily system default `SYSTEM_DEFAULT_UI_INTERVAL_SECONDS = 86400`).
- **~48h recovery lag** documented in CONTEXT.md + PRD: 2 successful daily runs to close.
- Key files: `packages/config-repo` (types, effective, repo, stores, `incident-orchestrator.applyUIIncidentForRun`), `packages/alerter` (per-check-type templates + `IncidentAlertEvent.checkType`), `apps/worker` (`ui-job` critical-fail + apply, `tick` UI pass, `index` enqueueUI). Tests: `effective.test`, `ui-incident-orchestrator.test`, `templates.test`, `ui-worker.test` (AC #5 end-to-end).

## Blocked by

- #10, #13, #08
