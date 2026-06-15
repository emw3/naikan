# Naikan

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
&nbsp;TypeScript · Bun · Node · Svelte 5 · Postgres · Playwright

**Naikan watches a portfolio of websites and tells you they broke before the client does.**
It runs fast **heartbeat checks** (HTTP/SSL/DNS, every few minutes) and daily
**UI checks** (three viewports, baseline screenshot diff + synthetic signals) across
many project sites, opens **incidents** and pages on realtime outages, rolls noisy
visual/console regressions into a **daily digest** instead of waking you at 3am — and
ships an **MCP agent** that judges whether a screenshot diff is a real regression or noise.

> **Status — built, demo-able MVP.** Designed and built end-to-end; runs as a full
> one-command local stack (`bun stack up`). It is *not* currently pointed at real
> production traffic. This repo is published as an engineering portfolio piece.

### 📖 Read the architecture writeup → [`ARCHITECTURE.md`](ARCHITECTURE.md)

A short tour of the system told through the five forces that shaped it (why the worker
is Node but the API is Bun, why baselines live outside the retention subtree, why a
visual regression never pages you, and how an agent judges its own product's diffs).
The full decision trail lives in [`docs/`](docs/) — 6 ADRs, per-feature PRDs, and the
tracer-bullet slices each feature was cut into.

### Engineering highlights

- **Per-process runtime split, settled by measurement.** API on Bun, Playwright
  worker on Node — chosen from a 50-iteration browser-launch benchmark, not vibes
  ([ADR-0001](docs/adr/0001-worker-runtime.md)).
- **Runtime-agnostic kernel.** `packages/*` is plain TypeScript with no Bun-only APIs,
  so the same domain code imports cleanly under either runtime
  ([ADR-0005](docs/adr/0005-repo-layout.md), [ADR-0006](docs/adr/0006-ui-capture-packages.md)).
- **Retention-safe artifact store.** An S3 key scheme where approved baselines sit
  *outside* the `runs/` subtree, so the retention reaper can delete by prefix and never
  reap a live baseline ([ADR-0002](docs/adr/0002-s3-key-convention.md)).
- **Pure decision cores.** The scheduler (`nextRunsFor`) and incident state machine take
  clock and DB as inputs and return decisions — trivially unit-testable, no mocks.
- **Agentic regression judge.** A stdio MCP server exposes read + verdict-only tools so
  an LLM can triage visual diffs; a human still owns promote-to-baseline. Backed by a
  golden-dataset [eval suite](EVALS.md) with an accuracy regression guard.

## Screenshots

The web-admin is a Svelte 5 SPA in a dark, table-led "operator dashboard" direction
([ADR-0007](docs/adr/0007-ui-vercel-dark-direction.md)).

<!-- screenshots:start -->
**Project overview** — the 30-second "what's broken" scan: status summary cards over a
checks table, status shown as a colored dot *and* a word (never color alone).

![Project overview](docs/screenshots/overview.png)

**UI check run detail** — per-signal results (load / console / selector / perf, each with
its severity) and the baseline / current / diff triptych with the diff percentage. This
is the run an agent judges over MCP.

![UI check run detail](docs/screenshots/run-detail.png)
<!-- screenshots:end -->

## Layout

Bun **workspaces monorepo** (see [ADR-0005](docs/adr/0005-repo-layout.md)):

- `packages/*` — plain-TypeScript kernel modules, **no Bun-specific APIs** (so the
  worker can fall back to a Node runtime). Currently `@naikan/kernel-core` (placeholder).
- `apps/api` — Bun + [Hono](https://hono.dev) API; serves `/health` and the built SPA.
- `apps/worker` — **Node** scheduler + queue consumer (ADR-0001): a 30s tick enqueues
  due checks, [graphile-worker](https://worker.graphile.org) runs them. See [Worker & scheduler](#worker--scheduler).
- `apps/web-admin` — Svelte 5 + Vite SPA.
- `apps/mcp` — **stdio MCP server** (`@naikan/mcp`) the platform ships so an agent can
  judge UI regressions over the HTTP API. See [Regression-judge agent (MCP)](#regression-judge-agent-mcp).
- `@naikan/scheduler` — pure decision module: `nextRunsFor(now, entries)` returns the
  checks due to run now (no clock or DB — both are passed in).

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3 (`curl -fsSL https://bun.sh/install | bash`)
- Postgres (only needed for migrations / DB access, not for `/health`)

## Setup

```sh
bun install
cp .env.example .env   # then edit DATABASE_URL / PORT
```

## Commands

| Command            | What it does                                                              |
| ------------------ | ------------------------------------------------------------------------- |
| `bun dev`          | Build the SPA, then start the API serving it at `/` (and `/health`).      |
| `bun run build`    | Build the Svelte SPA (`apps/web-admin/dist`).                             |
| `bun run start`    | Start the API only (expects the SPA already built).                       |
| `bun migrate`      | Apply migrations (`node-pg-migrate up`). Needs `DATABASE_URL`.            |
| `bun migrate:down` | Roll back the last migration (`node-pg-migrate down`).                    |
| `bun run smoke`    | Build → start API → assert `GET /health` → 200. No DB required.           |
| `bun run db:check` | Connect via the `postgres` lib using `DATABASE_URL` and run `select 1`.   |
| `bun test`         | Run unit tests (kernel packages + worker).                                |
| `bun run --cwd apps/worker start` | Start the worker (scheduler tick + graphile-worker consumer). |

### Quick demo

```sh
bun install
bun dev                 # in another shell:
curl localhost:3000/health   # -> {"status":"ok",...} (200), SPA at http://localhost:3000/
```

## Database & migrations

- Runtime DB access uses the [`postgres`](https://github.com/porsager/postgres)
  library (raw SQL, **no ORM**) — see `apps/api/src/db.ts`.
- Migrations use [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate)
  (raw SQL, forward + rollback). Migration files live in `migrations/`. The
  baseline is empty — it just establishes the tracking table.

```sh
DATABASE_URL=postgres://postgres:postgres@localhost:5432/naikan bun migrate
DATABASE_URL=... bun migrate:down
```

## Worker & scheduler

The worker is a **separate process from the API** (Node, not Bun — see
[ADR-0001](docs/adr/0001-worker-runtime.md)). It does two things over the same Postgres:

1. **Schedule** — every 30s a *tick* asks the pure `@naikan/scheduler`
   (`nextRunsFor(now, entries)`) which checks are due, and enqueues a
   `heartbeat-run` job for each (deduped per check via a `jobKey`).
2. **Consume** — [graphile-worker](https://worker.graphile.org) runs the
   `heartbeat-run` task, which calls `@naikan/heartbeat-runner` and writes a
   `CheckRun`. No scheduling logic lives in the handler — the tick decides *when*.

graphile-worker installs and owns its own `graphile_worker` schema on boot, so
`bun migrate` does **not** manage the queue tables.

```sh
# 1. apply app migrations (creates heartbeat_checks / check_runs), then:
DATABASE_URL=postgres://postgres:postgres@localhost:5432/naikan \
  bun run --cwd apps/worker start
```

The start script runs `node apps/worker/src/index.ts`; Node ≥ 22.18 strips the
TypeScript types natively, so the `.ts` kernel packages import with no build step.

| Env var              | Default | Purpose                                  |
| -------------------- | ------- | ---------------------------------------- |
| `DATABASE_URL`       | —       | Postgres connection (required).          |
| `WORKER_CONCURRENCY` | `5`     | Concurrent jobs per worker process.      |

**End-to-end demo:** create a heartbeat check with `interval_seconds=60` (via the
admin API), start the worker, and — without ever clicking *Run now* — its CheckRun
history fills with one row per minute.

### Docker

`docker compose up worker` runs the worker (and a local `postgres`) in containers;
see [`docker-compose.yml`](docker-compose.yml). Apply migrations first
(`bun migrate` against the compose Postgres).

## Self-monitoring (`/health`)

`GET /health` is the platform's own health probe (issue #18) — **unauthenticated**
so an external uptime monitor can poll it. It returns `200` with `{"status":"ok"}`
when the platform is monitoring itself, or `503` with
`{"status":"unhealthy", ...}` naming the failed assertion otherwise. Two checks:

1. **Queue lag** — the oldest graphile-worker job still *waiting* to run is younger
   than `HEALTH_QUEUE_LAG_SECONDS`. A stalled worker lets jobs age past this.
2. **Last-run freshness** — a `CheckRun` exists across all checks within
   `HEALTH_FRESHNESS_MULTIPLIER × (shortest configured heartbeat interval)`. A dead
   worker stops producing runs.

With no database configured (e.g. the no-DB smoke boot) there is nothing to
monitor, so both assertions pass. A probe failure (DB unreachable) returns `503`
rather than crashing — `/health` always answers.

| Env var                       | Default | Purpose                                                        |
| ----------------------------- | ------- | -------------------------------------------------------------- |
| `HEALTH_QUEUE_LAG_SECONDS`    | `300`   | Max age of the oldest waiting queue job before it's "lagging". |
| `HEALTH_FRESHNESS_MULTIPLIER` | `2`     | Freshness window = this × the shortest heartbeat interval.     |

**Point an uptime monitor at it.** In [UptimeRobot](https://uptimerobot.com) (or
any equivalent), add an **HTTP(s)** monitor for `https://<your-host>/health` that
treats any non-`2xx` as down. Use a **separate alert contact/channel from the
per-project alerts** (issue #10): per-project alerts say a *project site* is down;
this says the *monitoring platform itself* is down — and a down platform can't send
its own alerts, so the two must not share a delivery path.

**End-to-end demo:** stop the worker process — within `HEALTH_QUEUE_LAG_SECONDS`
(default 5 min) `/health` flips to `503`; restart it and once the queue drains
`/health` returns to `200`.

## Regression-judge agent (MCP)

Naikan ships a **stdio MCP server** (`apps/mcp`, `@naikan/mcp`) so an agent —
Claude or any MCP client — can judge whether a UI check run's screenshot **diff**
is a real visual regression or noise, and record a **verdict** back into the
product. The agent advises; a human still owns promote-to-baseline. Nothing
auto-promotes.

**What it exposes** (four tools): `list_ui_checks` → `list_ui_runs` (by checkId) →
`get_ui_run` (presigned baseline/current/diff URLs + per-viewport diff% + signals +
the current verdict) → `submit_verdict` (verdict kind, reasoning, confidence,
model). The procedure + verdict taxonomy live in the bundled
[`regression-judge` skill](.claude/skills/regression-judge/SKILL.md).

**Auth.** The server authenticates with a **scoped agent token** set on the API as
`NAIKAN_AGENT_TOKEN` — read-only + verdict-only (it can read runs and record
verdicts, but cannot run checks, promote baselines, or mutate config). Leave it
unset and the platform boots normally with the agent disabled (strictly opt-in).

**Configure** the server from the environment:

| Env var              | Purpose                                                      |
| -------------------- | ------------------------------------------------------------ |
| `NAIKAN_API_URL`     | Naikan API base URL, e.g. `http://localhost:3000`.           |
| `NAIKAN_AGENT_TOKEN` | The scoped agent bearer token (same value as on the API).    |

It fails fast with a clear message if either is unset.

**Register** it in an MCP client. For Claude Code, add it to `.mcp.json` (or via
`claude mcp add`):

```jsonc
{
  "mcpServers": {
    "naikan": {
      "command": "node",
      "args": ["apps/mcp/src/index.ts"],
      "env": {
        "NAIKAN_API_URL": "http://localhost:3000",
        "NAIKAN_AGENT_TOKEN": "<the scoped agent token>"
      }
    }
  }
}
```

(`bun apps/mcp/src/index.ts` works too — the server is plain TypeScript with no
Bun-only APIs, so it runs under Node or Bun.) Then run the `regression-judge` skill
against a check: the agent enumerates checks → runs → fetches one run's
baseline/current/diff + signals → judges → submits a verdict, which then surfaces in
`GET /api/uichecks/:id/runs/:runId` and as a badge in the run-detail view.

### Is the judge any good?

The judgment is measured, not asserted. [**EVALS.md**](EVALS.md) documents the labeled
golden dataset, the grader + harness (`@naikan/eval-dataset`), the measured
precision/recall + confusion matrix, and an honest failure-modes / limitations section.
A gated regression test fails CI if judge accuracy on the golden set drops below the
documented threshold.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on push / PR:

- **smoke** — `bun install` → `bun run smoke` (build + `/health` → 200).
- **migrate** — spins up Postgres, then `bun migrate` → `bun run db:check` → `bun migrate:down`.
