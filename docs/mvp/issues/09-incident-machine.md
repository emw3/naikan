# 09 — `incident-machine` + persisted incidents

Status: ready-for-human
Category: enhancement
Type: AFK

## Parent

`docs/mvp/PRD.md`

## What to build

The `incident-machine` module: a pure state machine that, given a stream of CheckRun results for one check + thresholds (`alert_after_n_fails`, hard-coded `M=2` consecutive successes to close), emits state transitions: `opened`, `still-open`, `closed-recovered(duration)`.

Persist the `Incident(id, check_id, opened_at, closed_at?, runs[])` table and write a thin orchestrator that, after each CheckRun, fetches the relevant tail of run history, runs the state machine, and applies the resulting transitions. UI surfaces open incidents on a per-project overview and shows closed ones in a history list.

Alerting is **not** in scope here — incidents transition silently. Email/Slack wiring lands in #10.

## Acceptance criteria

- [x] `Incident` migration applied
- [x] `incident-machine` is pure — no DB, no clock except injected
- [x] Orchestrator hook runs after each CheckRun write, applies any transition
- [x] Open incidents listed on per-project overview (count + oldest opened_at)
- [x] Closed incidents shown with computed duration
- [x] Table-driven unit tests on `incident-machine`: flap-open-then-recover, sustained outage, false flap with 1 success between fails, clean 2-success close
- [x] Integration test: drive 5 fail CheckRuns through orchestrator, see one Incident open; drive 2 successes, see it closed

## Blocked by

- #07
