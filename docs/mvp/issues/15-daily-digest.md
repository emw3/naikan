# 15 — Daily digest

Status: ready-for-human
Category: enhancement
Type: AFK

## Parent

`docs/mvp/PRD.md`

## What to build

The `digest-builder` module: a pure function `buildDigest(projectId, dateRange, runs, incidents) → DigestPayload`. The payload is the summary structure rendered into email + Slack: pass/fail counts per check, list of regressed UI checks, list of opened/closed incidents in the window, dashboard deep-link.

A scheduled job runs once per day (configurable time per manager? — MVP: single global send time, default 08:00 in a configurable TZ; per-manager TZ defer to v2). For each Project, build the digest; group all of one manager's projects into one email (and one Slack message per project's `slack_channel`, per the per-channel opt-in already on Project).

End-to-end demo: a manager owning 2 projects receives one email at 08:00 with both projects summarised; Slack messages appear in each project's channel.

## Acceptance criteria

- [x] `digest-builder` is pure; table-driven tests for: empty day, mixed pass/fail, open incident at end of day, closed incident inside day
- [x] Per-Project toggles: `digest_email_enabled`, `digest_slack_enabled`
- [x] Scheduled job runs daily at the configured time (env-controlled), iterates managers, builds + dispatches digests
- [x] Email aggregates a manager's projects; Slack posts per-project
- [x] Dashboard deep-links resolve to the per-project overview
- [x] Integration test: with seeded runs/incidents, the digest payload contains the expected sections

## Blocked by

- #10, #12, #13

## Comments

**Built (ready-for-human).** Worktree branch `worktree-issue-15-daily-digest`.

- **`@naikan/digest-builder`** — new pure, zero-dep kernel package. `buildDigest(input) → DigestPayload` aggregates one project's windowed runs + incidents into per-check pass/fail counts, regressed UI checks, and opened/closed incident lists with a dashboard deep-link. Window is half-open `[from, to)`. 9 table-driven tests (empty day, mixed pass/fail, window exclusion, regressed-UI surfacing, open-at-EOD, closed-in-day, opened-before/closed-in, fully-outside).
- **config-repo** — added per-Project `digestEmailEnabled` / `digestSlackEnabled` (migration `1860000000000_project-digest-flags.js`, both NOT NULL default true), `listRunsInWindow(checkId, from, to)` (a day of 5-min heartbeats exceeds `listRuns`' 50-row cap), and a read-only `getUser(id)` to resolve a Project's manager to a digest recipient (excludes soft-deleted). Wired through types + in-memory + pg stores.
- **alerter** — added pure `renderDigestEmail(managerName, payloads[])` and `renderDigestSlack(payload)` templates (plain-text MVP, alongside the incident templates).
- **worker** — `digest-job.ts` `runDigestSend()` gathers each project's window, builds payloads, posts one Slack message per opted-in project (webhook required) and one aggregated email per manager covering their email-opted-in projects. Best-effort per send. Fired by graphile-worker's own `crontab` (`DIGEST_CRON`, default `0 8 * * *` UTC) via a new `digest-send` task. 7-test integration suite covers the issue's end-to-end demo + every toggle/edge.

**Decisions / assumptions** (worth a human glance):
- Digest window is a rolling **last-24h** ending at fire time; per-manager timezone deferred to v2 (per the issue). Send time is a UTC cron, env-controlled.
- Digest **email recipient is the assigned manager's user email** (distinct from a Project's `alertEmails`, which are for incidents). Projects with no manager are skipped for email but still post Slack.
- Manager-email resolution lives in config-repo (`getUser`) — config-repo is the worker's only DB seam; auth still owns user writes.
- Greeting uses the manager's email (no user display-name field in the MVP data model).

**Verification:** `digest-builder` 9, `config-repo` (+digest) green, `alerter` 24, `worker` 34 (incl. digest integration), `api` 79 — all pass. `bun install --frozen-lockfile` consistent.

**Human merge gate (same as #10):** live Resend email + Slack webhook sends are best-effort and untested without `RESEND_API_KEY` / `ALERT_FROM_EMAIL` / real webhooks. The migration applies cleanly by format parity with #10/#14 but was **not** run against a live DB in this branch — CI's `migrate` job exercises it.
