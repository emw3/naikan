#!/usr/bin/env bash
#
# dev-stack.sh — boot or tear down the full local stack for THIS worktree.
#
# One command instead of five. Each worktree is isolated: its own Postgres +
# MinIO (compose project = worktree dir name) on auto-assigned host ports, so
# multiple worktrees can run side by side without the 5432/9000 collisions you
# hit otherwise. Chosen ports + background PIDs are recorded in .dev/state.env.
#
#   bun stack up      # infra + migrate + seed + API + worker, then print URL/creds
#   bun stack down    # stop API + worker, stop containers (volumes/data kept)
#   bun stack logs    # tail the API + worker logs
#   bun stack status  # show what's running and on which ports
#
# Why the worker runs on the host (not in a container): it needs Playwright +
# Chromium for UI checks (ADR-0001/0006), and the browsers are already installed
# on the host. The script finds a Node >= 22.18 (native .ts) for it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
DEV="$ROOT/.dev"
STATE="$DEV/state.env"
mkdir -p "$DEV"

# Compose project name = sanitized worktree dir, so infra is scoped per worktree.
PROJECT="$(basename "$ROOT" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//')"

# This shell may have been initialized from a profile whose nvm lazy-loader
# (`_load_nvm`) is broken — invoking `node` then recurses through
# command_not_found_handler forever. Drop both so node resolves normally.
unset -f command_not_found_handler _load_nvm 2>/dev/null || true

log()  { printf '\033[36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# --- find a Node >= 22.18 (worker needs native .ts type-stripping) ------------
find_node() {
  local candidates=()
  command -v node >/dev/null 2>&1 && candidates+=("$(command -v node)")
  # nvm installs, newest major first
  if [ -d "$HOME/.nvm/versions/node" ]; then
    while IFS= read -r n; do candidates+=("$n"); done \
      < <(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -rV)
  fi
  candidates+=(/usr/local/bin/node /usr/bin/node)
  for c in "${candidates[@]}"; do
    [ -x "$c" ] || continue
    if "$c" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null; then
      printf '%s' "$c"; return 0
    fi
  done
  return 1
}

NODE_BIN="$(find_node)" || die "no Node >= 22.18 found (needed by the worker). Install via nvm: nvm install 22"
export PATH="$(dirname "$NODE_BIN"):$PATH"

# NB: process.stdout.write (not console.log) — console.log colorizes a bare
# number when FORCE_COLOR is set, even through a pipe, which would poison the port.
free_port() { "$NODE_BIN" -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})'; }

compose() { docker compose -p "$PROJECT" "$@"; }

pg_url()       { echo "postgres://postgres:postgres@localhost:${CM_PG_PORT}/naikan"; }
# Host used in the S3 endpoint. Presigned screenshot URLs are handed to the BROWSER,
# so this host must be reachable from wherever you open the app. Default localhost;
# set CM_S3_HOST (e.g. a Tailscale/LAN name) when testing from another device.
s3_endpoint()  { echo "http://${CM_S3_HOST:-localhost}:${CM_MINIO_PORT}"; }
# Primary LAN IPv4 — the API binds 0.0.0.0, so this address reaches it from another device.
lan_ip()       { hostname -I 2>/dev/null | awk '{print $1}'; }

# Env every host-side process (migrate/seed/api/worker) needs. The worker is Node
# and does NOT auto-load .env (Bun does), so we always pass these explicitly.
stack_env() {
  echo "DATABASE_URL=$(pg_url)"
  echo "S3_ENDPOINT=$(s3_endpoint)"
  echo "S3_BUCKET=naikan-artifacts"
  echo "S3_REGION=us-east-1"
  echo "S3_ACCESS_KEY_ID=minioadmin"
  echo "S3_SECRET_ACCESS_KEY=minioadmin"
  echo "WORKER_CONCURRENCY=5"
}

alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

cmd_up() {
  command -v docker >/dev/null 2>&1 || die "docker not found"
  docker info >/dev/null 2>&1 || die "docker daemon not reachable"

  [ -f .env ] || { cp .env.example .env; log "created .env from .env.example"; }

  # Reuse the ports from a stack that's already up; otherwise pick free ones.
  if [ -f "$STATE" ] && compose ps --status running 2>/dev/null | grep -q postgres; then
    # shellcheck disable=SC1090
    . "$STATE"; log "reusing running infra on pg:$CM_PG_PORT minio:$CM_MINIO_PORT"
  else
    CM_PG_PORT="$(free_port)"
    CM_MINIO_PORT="$(free_port)"
    CM_MINIO_CONSOLE_PORT="$(free_port)"
    CM_API_PORT="$(free_port)"
    log "allocated ports — pg:$CM_PG_PORT minio:$CM_MINIO_PORT console:$CM_MINIO_CONSOLE_PORT api:$CM_API_PORT"
  fi
  export CM_PG_PORT CM_MINIO_PORT CM_MINIO_CONSOLE_PORT CM_API_PORT

  log "starting infra (postgres + minio) for project '$PROJECT'"
  compose up -d minio createbuckets postgres

  log "waiting for postgres to become healthy"
  for _ in $(seq 1 60); do
    [ "$(compose ps postgres --format '{{.Health}}' 2>/dev/null)" = "healthy" ] && break
    sleep 1
  done
  [ "$(compose ps postgres --format '{{.Health}}' 2>/dev/null)" = "healthy" ] || die "postgres did not become healthy"

  log "applying migrations"
  env "$(stack_env | grep DATABASE_URL)" bun migrate >/dev/null
  log "seeding admin (idempotent)"
  env $(stack_env) SEED_ADMIN_EMAIL="${SEED_ADMIN_EMAIL:-admin@example.com}" \
      SEED_ADMIN_PASSWORD="${SEED_ADMIN_PASSWORD:-change-me-in-prod}" bun run seed:admin

  # Restart any previously-started app processes cleanly.
  stop_apps

  log "building SPA"
  bun run build:web >/dev/null

  log "starting API on :$CM_API_PORT"
  env $(stack_env) PORT="$CM_API_PORT" setsid bun run apps/api/src/index.ts \
      >"$DEV/api.log" 2>&1 & echo $! > "$DEV/api.pid"

  log "starting worker"
  env $(stack_env) setsid bun run --cwd apps/worker start \
      >"$DEV/worker.log" 2>&1 & echo $! > "$DEV/worker.pid"

  {
    echo "CM_PG_PORT=$CM_PG_PORT"
    echo "CM_MINIO_PORT=$CM_MINIO_PORT"
    echo "CM_MINIO_CONSOLE_PORT=$CM_MINIO_CONSOLE_PORT"
    echo "CM_API_PORT=$CM_API_PORT"
  } > "$STATE"

  # Wait for /health so we report a stack that's actually serving.
  log "waiting for API /health"
  local ok=""
  for _ in $(seq 1 30); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$CM_API_PORT/health" 2>/dev/null)" = "200" ] && { ok=1; break; }
    sleep 1
  done
  echo
  if [ -n "$ok" ]; then
    printf '\033[32m✓ stack up\033[0m  (project: %s)\n' "$PROJECT"
  else
    warn "API not healthy yet — check $DEV/api.log"
  fi
  echo "  app:      http://localhost:$CM_API_PORT"
  local ip; ip="$(lan_ip)"
  if [ -n "$ip" ]; then echo "  app (LAN): http://$ip:$CM_API_PORT   (API binds 0.0.0.0; set HOST=127.0.0.1 to restrict)"; fi
  echo "  login:    ${SEED_ADMIN_EMAIL:-admin@example.com} / ${SEED_ADMIN_PASSWORD:-change-me-in-prod}"
  echo "  minio:    http://localhost:$CM_MINIO_PORT  (console :$CM_MINIO_CONSOLE_PORT, minioadmin/minioadmin)"
  echo "  postgres: $(pg_url)"
  echo "  logs:     bun stack logs   |   stop: bun stack down"
}

stop_apps() {
  for svc in api worker; do
    local pidfile="$DEV/$svc.pid"
    [ -f "$pidfile" ] || continue
    local pid; pid="$(cat "$pidfile")"
    if alive "$pid"; then
      # setsid gives each its own process group; kill the whole group.
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  done
}

cmd_down() {
  log "stopping API + worker"
  stop_apps
  if [ -f "$STATE" ]; then . "$STATE"; export CM_PG_PORT CM_MINIO_PORT CM_MINIO_CONSOLE_PORT CM_API_PORT; fi
  log "stopping containers (data volumes kept)"
  # `down` (no -v) removes containers + network, frees ports, keeps named volumes.
  CM_PG_PORT="${CM_PG_PORT:-5432}" CM_MINIO_PORT="${CM_MINIO_PORT:-9000}" \
  CM_MINIO_CONSOLE_PORT="${CM_MINIO_CONSOLE_PORT:-9001}" compose down 2>/dev/null || true
  printf '\033[32m✓ stack down\033[0m  (project: %s; volumes preserved)\n' "$PROJECT"
}

cmd_logs() {
  [ -f "$DEV/api.log" ] || die "no logs yet — run 'bun stack up' first"
  tail -n 40 -f "$DEV/api.log" "$DEV/worker.log"
}

cmd_status() {
  echo "project: $PROJECT"
  [ -f "$STATE" ] && { . "$STATE"; echo "ports — pg:$CM_PG_PORT minio:$CM_MINIO_PORT console:$CM_MINIO_CONSOLE_PORT api:$CM_API_PORT"; }
  for svc in api worker; do
    local pid; pid="$( [ -f "$DEV/$svc.pid" ] && cat "$DEV/$svc.pid" || true )"
    if alive "$pid"; then echo "$svc: running (pid $pid)"; else echo "$svc: stopped"; fi
  done
  compose ps 2>/dev/null || true
}

case "${1:-up}" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  logs)   cmd_logs ;;
  status) cmd_status ;;
  *) die "usage: bun stack {up|down|logs|status}" ;;
esac
