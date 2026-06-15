# 02 — Verdict API + scoped agent token

Status: done
Category: enhancement
Type: AFK

Implemented in commit `67d1362`. Listed for traceability — do not re-do.

## Parent

`docs/regression-judge/PRD.md`

## What to build

The HTTP surface for recording + reading a verdict, plus a **scoped agent
credential** so an external agent (the `@naikan/mcp` server) can authenticate
without a browser session — read-only on everything, write-only for verdicts, never
admin.

## Acceptance criteria

- [x] `POST /api/uichecks/:id/runs/:runId/verdict` records a verdict (project-gated; `ValidationError` → 400; missing run → 404)
- [x] the run-detail `GET` returns the latest verdict (null until judged)
- [x] `requireAuth` accepts a configured `NAIKAN_AGENT_TOKEN` bearer (constant-time compare) → a read-only **agent principal** (`viewer`)
- [x] scoping is **by role**: the agent token authenticates everywhere but the admin gate returns 403 (not 401) — so the agent reads + records verdicts but cannot run-now / promote / CRUD
- [x] no token configured → session-only; the platform still boots + serves
- [x] route tests: record → surfaces in run-detail, both credentials (session + token), 401 / wrong-token / 400 / 404, and agent-token-cannot-write-admin (403)

## Blocked by

None.
