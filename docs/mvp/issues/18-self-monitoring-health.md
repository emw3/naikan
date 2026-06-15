# 18 — Self-monitoring `/health`

Status: ready-for-human — `/health` promoted to two assertions (queue lag via
`graphile_worker.jobs` view + last-run freshness via `config-repo`), 200/503 with the
failed assertion named in the body, env-configurable thresholds, ≤10s queue-lag cache,
unauthenticated. Built TDD-first (pure `assessHealth` core + injected `HealthProbe`); the
stop-worker→503 / restart→200 demo is exercised at the probe seam (no real-DB harness in
this repo, matching worker.test.ts). No-DB boot preserved (smoke still 200). README +
.env.example documented. 24 health tests + 2 repo tests; full api+config-repo suite green.
Awaiting human review/merge.
Category: enhancement
Type: AFK

## Parent

`docs/mvp/PRD.md`

## What to build

Promote the placeholder `/health` from #01 into a meaningful endpoint that returns non-2xx when the platform itself is unhealthy. Two assertions:

1. **Queue lag** — the oldest waiting graphile-worker job is younger than a configured threshold (default 5 minutes).
2. **Last-run freshness** — there exists a CheckRun across all checks within the last `2 × (shortest configured heartbeat interval)`.

`/health` returns 200 when both hold, 503 (with a JSON body naming the failed assertion) otherwise. The endpoint is unauthenticated so an external uptime service can hit it.

End-to-end demo: stop the worker process — within `5 minutes` `/health` flips to 503; restart the worker — `/health` returns to 200 once the queue drains.

## Acceptance criteria

- [ ] `/health` performs both assertions and returns 200/503 accordingly
- [ ] Thresholds env-configurable (`HEALTH_QUEUE_LAG_SECONDS`, `HEALTH_FRESHNESS_MULTIPLIER`)
- [ ] Endpoint completes in <500ms (cache the queue-lag query for ≤10s if needed)
- [ ] README documents pointing UptimeRobot at this endpoint and recommends a separate alert channel from per-project alerts
- [ ] Tests: integration test stops the worker, asserts /health becomes 503 within threshold; restart, asserts recovery

## Blocked by

- #07
