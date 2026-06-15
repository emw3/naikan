# 17 — Retention reaper

Status: ready-for-agent
Category: enhancement
Type: AFK

## Parent

`docs/mvp/PRD.md`

## What to build

A daily scheduled job that, per Project, deletes CheckRun artifacts in `baseline-store` older than `Project.retention_days`. The latest baseline per UICheck is exempt and never reaped. Database `CheckRun` rows referencing deleted artifacts are kept (history rows are cheap) but their `artifacts_ref` is set to a tombstone so the UI can show "artifacts expired".

End-to-end demo: a project configured with `retention_days=1` — yesterday's UICheck runs lose their per-viewport screenshots from S3, the dashboard reflects them as expired, but the baseline screenshots remain accessible.

## Acceptance criteria

- [x] Daily reaper job registered with the scheduler
- [x] Per-Project retention window honoured
- [x] Baseline keys (referenced by `UICheck.baseline_image_ref`) skipped during reap
- [x] CheckRun `artifacts_ref` rewritten to tombstone marker after reap
- [x] Dashboard shows "artifacts expired" placeholder for reaped runs
- [x] Tests: seed runs across a retention boundary, run reaper, assert exactly the past-retention non-baseline keys are deleted

## Blocked by

- #04
