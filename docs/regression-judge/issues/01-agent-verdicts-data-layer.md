# 01 — agent_verdicts data layer

Status: done
Category: enhancement
Type: AFK

Implemented in commit `a71491c`. Listed for traceability — do not re-do.

## Parent

`docs/regression-judge/PRD.md`

## What to build

The persistence + repo seam for an **AgentVerdict**: an agent's classification of a
UI **Check run**'s **Diff** as `real_regression` / `noise` / `intentional` /
`uncertain`, with optional confidence, reasoning, and the model that produced it.
Agent-generated telemetry — recorded, never audited (mirrors CheckRun / Incident).

## Acceptance criteria

- [x] `agent_verdicts` migration: `run_id` FK → `check_runs(id)` ON DELETE CASCADE, `verdict` with a CHECK constraint over the four kinds, nullable `confidence` (0..1 CHECK), `reasoning`, `model`, `created_at`, index on `run_id`
- [x] `AgentVerdict` / `AgentVerdictInput` / `VerdictKind` types exported from `@naikan/config-repo`
- [x] `verdicts` block on `ConfigStore` (`insert` / `listByRun` / `latestByRun`) in both the pg store and the in-memory store
- [x] repo `recordVerdict` (validates kind, non-empty reasoning + model, 0..1 confidence; non-audited) + `getLatestVerdict` + `listVerdicts`
- [x] table-driven tests: persistence, newest-first ordering, validation failures

## Blocked by

None.
