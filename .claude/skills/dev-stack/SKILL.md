---
name: dev-stack
description: Boot or tear down the full naikan local stack (Postgres + MinIO + API + Playwright worker) for the current worktree. Use when asked to "start/boot/run the local stack", "spin up the app locally", "test manually in the browser", or to stop/restart it. Wraps scripts/dev-stack.sh.
---

# Running the full local stack

The whole stack boots with **one command**. Always prefer it over the
five manual steps (infra / migrate / seed / API / worker) — it encodes
the fixes for the traps below.

```bash
bun stack up       # infra + migrate + seed + API + worker; prints URL + creds
bun stack down     # stop API + worker, stop containers (data volumes kept)
bun stack logs     # tail API + worker logs (.dev/api.log, .dev/worker.log)
bun stack status   # ports + PIDs + container state
```

`up` prints the app URL, the admin login, and the MinIO/Postgres
ports. Open the URL, log in, exercise the change. Driving it (create a
UI check → **Run now** → open the run detail → read the Signals
section) is the point; a 200 on `/health` alone isn't "tested".

## What the script handles (don't rediscover these)

- **Per-worktree isolation.** Compose project = worktree dir name;
  host ports for Postgres/MinIO/API are **auto-assigned to free
  ports** (recorded in `.dev/state.env`). Multiple worktrees run side
  by side — no 5432/9000 collisions.
- **Broken nvm shell.** The interactive zsh here has a broken
  `_load_nvm` lazy-loader: invoking `node` recurses through
  `command_not_found_handler` forever. The script does
  `unset -f command_not_found_handler _load_nvm` and finds a Node
  >= 22.18 itself (worker needs native `.ts`). If you run node
  **manually** outside the script, do the same unset first.
- **Worker env.** The worker is Node (ADR-0001) and does **not**
  auto-load `.env` (Bun does), so the script passes `DATABASE_URL` +
  all `S3_*` explicitly. Email alerting stays unconfigured locally
  (Slack-only) — that's expected, not an error.
- **`.env`** is created from `.env.example` on first `up`.

## Prerequisites

- Docker daemon running (`docker info`).
- Playwright Chromium installed on the host (worker captures use it):
  `~/.cache/ms-playwright` should contain a `chromium-*` dir. If not:
  `bunx playwright install chromium`.

## Manual fallback (only if the script is unavailable)

```bash
unset -f command_not_found_handler _load_nvm        # fix the shell first
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"
docker compose up -d minio createbuckets postgres   # fixed :5432/:9000/:9001
DATABASE_URL=postgres://postgres:postgres@localhost:5432/naikan bun migrate
bun run seed:admin                                  # admin@example.com / change-me-in-prod
bun dev                                             # API + SPA on :3000
# worker, separate shell, env explicit:
DATABASE_URL=…  S3_ENDPOINT=http://localhost:9000 S3_BUCKET=naikan-artifacts \
  S3_REGION=us-east-1 S3_ACCESS_KEY_ID=minioadmin S3_SECRET_ACCESS_KEY=minioadmin \
  bun run --cwd apps/worker start
```
