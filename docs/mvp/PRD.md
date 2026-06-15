# Naikan Monitor — MVP

Status: needs-triage

## Problem Statement

Naikan account managers and developers maintain a portfolio of project websites. When a project's site breaks — goes down, regresses visually, loses an SSL cert, errors in the console, slows past the perf budget — the team currently finds out via the project (or by accident), not proactively. There is no shared, automated surface that says "here is what changed across all your projects in the last 24 hours" or "project X's checkout page has been failing for 18 minutes."

Manual spot-checks don't scale across projects, and ad-hoc tools (existing Sentinel design-review plugin, browser dev tools, hosting dashboards) are operator-driven and don't run on their own. The team needs a configure-once, run-automatically platform that produces a daily per-project digest and pages someone when something is actually broken.

## Solution

A small internal monitoring platform that, per project, runs two classes of automated checks:

- **Heartbeat checks** — every 5–15 minutes, hit each tracked URL and assert HTTP status, response body content, SSL certificate validity, and DNS resolution.
- **UI checks** — daily, capture three viewports per page (mobile, tablet, desktop), compare each against an approved baseline screenshot (with per-check pixel-diff threshold and CSS-selector ignore regions), and collect synthetic signals: page-load success, JavaScript console errors, presence of required selectors, and Web-Vitals perf budget.

Configuration lives in Postgres and is edited through a Svelte admin UI. Two roles: Admin (CRUD) and Viewer (read). Each project is owned by one assigned account manager.

When a heartbeat check fails a configurable number of consecutive times, the platform opens an Incident and sends a realtime alert (email + Slack, per-project routing). UI checks whose `critical` signal fails (by default, the page failed to load) likewise open an Incident and alert realtime; the other UI signals roll into the daily digest. Incidents auto-close after two consecutive successful runs and send a "recovered after N minutes" alert.

Every day at a fixed time, each account manager receives a digest summarising the last 24 hours for their assigned projects: pass/fail counts, list of regressions, link to the dashboard for full detail (screenshots, diffs, perf trend). The platform monitors itself by exposing a `/health` endpoint asserting queue lag and last-run freshness, polled by an external uptime service.

## User Stories

### Configuration (Admin role)

1. As an admin, I want to create a new Project with name, contacts, Slack channel, alert email list, retention-days override, and assigned manager, so that I can onboard a new project in one form.
2. As an admin, I want to attach one or more Sites to a Project (each with a base URL), so that I can monitor staging and production separately.
3. As an admin, I want to add a HeartbeatCheck to a Site with path, body assertion (regex or JSON path), cert-expiry threshold, DNS check toggle, interval, and alert-after-N-fails, so that I can describe what "up" means for that endpoint.
4. As an admin, I want to add a UICheck to a Site with path, viewport set, required selectors, ignore-region selectors, per-channel perf budget overrides, per-signal severity, and diff threshold, so that I can describe what "visually correct" means for that page.
5. As an admin, I want to define a CheckGroup with default interval and alert routing, so that I can apply a shared policy to many checks (e.g. "prod-critical: 5min, page on-call").
6. As an admin, I want individual checks to inherit their CheckGroup's policy by default, and to optionally override any field, so that I can tune one check without breaking the policy.
7. As an admin, I want to set a per-project retention window in days for stored artifacts (default 90), so that storage cost stays proportional to project value.
8. As an admin, I want to approve the current run as the new baseline for a UI check, so that intentional design changes don't keep generating noise.
9. As an admin, I want to edit any check, group, site, or project and see the audit log of who changed what when, so that I can investigate "why did this start alerting yesterday."
10. As an admin, I want to manually trigger any check from the admin UI and see the result inline, so that I can validate a config change without waiting for the next scheduled run.

### Daily operation (Manager + Viewer)

11. As an account manager, I want a daily email digest covering only my assigned projects, summarising pass/fail counts and listing regressions with a link to the dashboard, so that I can scan it in 30 seconds at the start of the day.
12. As an account manager, I want the digest also delivered as a Slack message in my channel, per-project opt-in, so that the team sees it in context.
13. As an account manager, I want the digest to link directly to each failing or regressed check's detail page, so that I can drill down without searching.
14. As a viewer, I want to browse all projects and see each project's current status (last 24h pass/fail per check), so that I can answer "is X OK right now."
15. As a viewer, I want to see a UI check's diff (side-by-side baseline vs current with diff overlay) and the artifact for each viewport, so that I can decide if it's a real regression or noise.
16. As a viewer, I want to see a heartbeat check's last 24h timeline (success/fail per run with latency), so that I can correlate with deployments or external events.
17. As a viewer, I want to see open Incidents across my projects with opened-at, duration so far, and the failing check, so that I know what's broken right now.
18. As a viewer, I want to see closed Incidents with downtime duration and the runs spanning the incident, so that I can produce an uptime report when asked.

### Alerting

19. As an account manager, I want a realtime alert (email + Slack, per my project's routing) when a heartbeat check has failed N consecutive times, so that I find out within minutes rather than the next morning.
20. As an account manager, I want a realtime alert when a UI check's load signal fails (page didn't render at all), so that I treat it as an outage even though it's a UI check.
21. As an account manager, I want a recovery alert with downtime duration when an Incident auto-closes, so that I know the situation is over without checking the dashboard.
22. As an account manager, I want UI regression / console errors / perf-budget violations to appear only in the daily digest, not as realtime alerts, so that I'm not paged at 3am for a hero-image change.
23. As an account manager, I want to set per-signal severity on a UI check (load/console/selector/perf each = critical or warning), so that I can escalate signals that matter for that specific page.

### Self-monitoring

24. As an admin, I want the platform to expose a `/health` endpoint that returns non-2xx when queue lag exceeds threshold or the last successful run is older than 2× the shortest interval, so that an external uptime service can detect platform-level outages.
25. As an admin, I want to point an external uptime service (UptimeRobot or similar) at `/health` and receive alerts in a separate channel from per-project alerts, so that "no alerts" doesn't silently mean "platform is down."

### Authentication

26. As a Naikan employee, I want to log in with my email and password, so that I can access the admin UI.
27. As an admin, I want to create new users and assign role (Admin or Viewer), so that I control who has access.

## Implementation Decisions

### Architecture

- New repo `naikan`, separate from `sentinel`. Shared visual-comparison kernel (Playwright capture, pixelmatch diff, CSS extract) is **copied** from sentinel into this repo; both sides keep a `SYNC.md` listing the copied modules and the last-synced commit hash so drift is at least visible during code review.
- Single-region AWS deployment. ECS Fargate: one task definition for the API + admin UI, separate task definition for workers (scaled independently because Playwright is RAM-heavy). RDS Postgres. S3 for artifacts. CloudFront fronts the Svelte SPA build.
- API + SSR layer: Bun + Hono. SPA: Svelte (Vite-built, served via CloudFront). API talks to Postgres via raw SQL (the `postgres` library or equivalent — no ORM).
- Queue: graphile-worker on the same Postgres instance. Scheduler enqueues jobs; worker tasks consume.
- ⚠ Flag for spike before commit: Playwright on Bun has had rough edges historically. If the spike shows instability, the worker process runs on Node while the API stays on Bun. The kernel modules must therefore be plain TypeScript with no Bun-specific APIs.

### Deep modules

The work is structured around isolatable, deeply-tested modules. Each has a narrow interface and hides substantial behaviour.

1. **`scheduler`** — pure. Input: list of check configs + current time + last-run-at per check. Output: list of jobs to enqueue. Hides interval math, CheckGroup policy inheritance, per-check override merging. No clock, no DB — both injected.
2. **`heartbeat-runner`** — pure executor. Input: HeartbeatCheck config. Output: CheckRun result (status, latency, error). Wraps HTTP fetch, DNS lookup, SSL cert inspection, body assertion behind one `runHeartbeat(config) → Result`.
3. **`ui-runner`** — wraps the Sentinel-derived kernel. Input: UICheck config + baseline artifact refs. Output: signals (load/console/selector/perf), screenshots per viewport, diff artifacts per viewport. No S3 or DB writes — returns buffers.
4. **`incident-machine`** — pure state machine. Input: stream of CheckRun results for one check + thresholds (N-fails-to-open, M-successes-to-close). Output: state transitions (opened, still-open, closed-recovered with duration).
5. **`alerter`** — dispatches alerts. Input: alert payload + project routing. Output: send via Email and/or Slack. Channel adapters hidden behind one `dispatch(alert, routing)`.
6. **`digest-builder`** — pure. Input: project id + date range + runs + incidents. Output: digest payload with summary stats and dashboard URLs.
7. **`baseline-store`** — S3 wrapper. CRUD over screenshot/diff artifacts, plus per-project retention enforcement. Hides key conventions and the retention reaper job.
8. **`config-repo`** — DB-backed repository for Project / Site / CheckGroup / HeartbeatCheck / UICheck. CRUD + group-policy resolution.
9. **`auth`** — email/password login, session cookies, role-check middleware.

Shallow/glue layers: **`api`** (Hono routes wrapping modules), **`worker`** (queue consumer orchestrating runners + repo + store + machine), **`web-admin`** (Svelte SPA).

### Data model

- `Project(id, name, contacts, slack_channel, alert_emails[], retention_days, assigned_manager_id → User.id, created_at, updated_at)`
- `Site(id, project_id, base_url, created_at, updated_at)`
- `CheckGroup(id, project_id, name, default_interval_seconds, default_alert_routing, default_alert_after_n_fails)`
- `HeartbeatCheck(id, site_id, group_id?, path, body_assertion?, cert_check, dns_check, interval_seconds?, alert_after_n_fails?)` — group fields inherited when null.
- `UICheck(id, site_id, group_id?, path, viewports[], selectors[], ignore_regions[], perf_budget, diff_threshold, severity_load, severity_console, severity_selector, severity_perf, baseline_image_ref?)`
- `CheckRun(id, check_id, check_type, started_at, finished_at, status, latency_ms, error?, artifacts_ref?)`
- `Incident(id, check_id, opened_at, closed_at?, runs[])`
- `User(id, email, password_hash, role, created_at)`
- `AuditLog(id, user_id, entity_type, entity_id, action, diff_json, created_at)`

### Behavioural rules

- Group-policy inheritance is resolved in `config-repo` and `scheduler`, not at the call site. A check's effective interval is `check.interval ?? group.default_interval ?? system_default`.
- Incident is opened after N consecutive incident-relevant fails and closed after 2 consecutive successes; recovery alert includes `closed_at - opened_at` duration. Heartbeat and UI checks share one incident-machine (#14): for a heartbeat check the signal is the run pass/fail (threshold = `alert_after_n_fails`); for a UI check the signal is a `critical`-severity Signal failing (threshold fixed at 1 — pages on the first critical fail). UI checks run daily, so a UI recovery alert lags up to ~48h.
- UI check is failed if any of its signals fail; per-signal severity controls whether the failure pages realtime (critical → opens an Incident) or only contributes to the digest (warning). The load signal defaults to critical; others default to warning. The run's `critical_failed` flag (did a critical Signal fail?) is the incident signal, distinct from `status` (any signal/regression — for the digest).
- Baseline approval is one-click: the operator picks a CheckRun in the admin UI and "promote to baseline" copies its artifacts to the baseline ref for that UI check.
- Retention is enforced by a daily reaper job in the worker pool, scanning per-project retention windows; the latest baseline per UI check is exempt.

### Operational decisions

- Email channel: transactional provider (Postmark, SES, or similar — TBD during build).
- Slack channel: Slack incoming webhooks per project; webhook URL is part of `Project` config.
- External uptime ping: configured outside the platform (e.g. UptimeRobot) pointing at `/health`.
- Self-host: no project-site credentials stored in MVP — public sites only. Sentinel's auth-config field is intentionally unused.

## Testing Decisions

A good test exercises the **external behaviour** of a module — its public interface and observable outputs — and never depends on its internals. A test that breaks when you rename a private function or restructure an `if`-tree is a bad test; a test that breaks when behaviour changes is a good test.

For this MVP the deeply-testable modules are the pure or near-pure ones, where a small synthetic input produces a deterministic output. These are also the modules where bugs are expensive to catch via end-to-end runs (a wrong inheritance rule in the scheduler could hide for weeks).

Modules with unit/integration tests in MVP:

1. **`scheduler`** — table-driven tests over (checks, now, last_run_at) → expected enqueue list. Cover: simple intervals, group-policy inheritance, per-check override, mixed groups, checks with no group.
2. **`heartbeat-runner`** — tests against a local HTTP mock server (covers status codes, body assertions, slow responses) plus a DNS stub and a cert-inspector stub. Verify each of the four signal types produces the right Result shape.
3. **`ui-runner`** — tests against a fixture HTML page served locally (covers selector presence, console errors via injected scripts, perf timing via Playwright tracing, baseline diff via known-good and known-bad fixture screenshots). The visual-diff portion is testable deterministically because pixelmatch on identical inputs returns zero.
4. **`incident-machine`** — table-driven tests over (run history, thresholds) → expected transitions. Cover: flap (open then immediately recover), sustained outage (open, stay open across many runs), false-flap (1 success between fails), clean recovery (2 successes close).
6. **`digest-builder`** — table-driven tests over (runs, incidents, date range) → digest payload structure. Cover: empty day, mixed pass/fail, open incident at end of day, closed incident inside day.
7. **`baseline-store`** — tests run against MinIO (S3-compatible) in CI. Cover: store + retrieve, retention reaper deletes only past-retention non-baseline artifacts, list by check id.

Modules **not** tested at unit level in MVP — covered via one end-to-end smoke test only:

- `alerter` (5) — channel adapters are thin wrappers over SDK calls; assert via a recorded fake during smoke.
- `config-repo` (8) — straight CRUD over SQL, low risk; covered by API integration test.
- `auth` (9) — uses well-trodden libraries.
- `api`, `worker`, `web-admin` — orchestrators / UI, covered by smoke test (run a heartbeat check + a UI check end-to-end against fixture sites).

### Prior art

The `sentinel` repo provides the capture / diff / extract patterns that `ui-runner` will reuse. Its current code is operator-driven (no test harness for the diff path); the new platform must add deterministic fixture-based tests around those operations as it copies them in.

## Out of Scope

- **Project-site credentials.** No basic-auth, cookie-auth, or login-flow handling in MVP. Sentinel's auth-config wiring is unused. Adding this means Secrets Manager + write-only admin fields + new test surface for authenticated capture.
- **Functional smoke flows.** No scripted "log in → navigate → click button → assert" flows. UI checks are stateless single-page captures only.
- **Figma fidelity comparison.** The existing Sentinel design-review use case stays in Sentinel-the-plugin; this platform does not schedule Figma-vs-prod comparisons.
- **Per-project RBAC.** No scoping of which users can see which projects beyond the two flat roles. SSO is also out of scope.
- **Multi-region check execution.** All checks run from one AWS region. Geo-distributed heartbeat is a v2 concern.
- **External report send to projects.** Digests go to internal account managers only. Sending reports to project contacts opens contractual implications and is deferred.
- **CloudWatch alarms / fine-grained platform observability.** A single external `/health` ping covers self-monitoring in MVP.
- **Audit log UI.** Audit log is recorded (`AuditLog` table) but exposed only via DB query for MVP; admin UI surfacing comes later.
- **Approval workflow for new projects / checks.** Admins can create entities directly with no review step.
- **API for third-party integrations.** No public/internal HTTP API surface beyond what the admin UI consumes.

## Further Notes

- **Repo bootstrap.** This PRD lives at `docs/mvp/PRD.md`. At the time of writing the repo was otherwise empty — first implementation step is bootstrapping Bun + Hono + Svelte + Postgres + Drizzle-equivalent migrations.
- **Kernel sync discipline.** Because the visual-comparison kernel is copied from `sentinel` rather than shared via a workspace package, any bug fix in either repo's kernel must be ported. A `SYNC.md` at the root of each repo should list the copied files and the commit hash they were last synced at. Worth revisiting in v2 whether the kernel should be extracted into a shared private package.
- **Playwright/Bun risk.** Run a spike before committing to Bun for the worker process. If it's unstable, the worker becomes a Node process; the kernel itself is plain TypeScript and runs on either.
- **Storage projection.** 3 viewports × (baseline + current + diff) = 9 artifacts per UI check per run. At ~500KB per PNG that's ~4.5MB per UI check per day. For a 90-day retention with N projects × M pages per project, plan S3 sizing accordingly during build.
- **Defaults to ship with.** Heartbeat alert-after-N-fails = 3. UI signal severities: load=critical, console=warning, selector=warning, perf=warning. Perf budget: LCP < 2.5s, page weight < 3MB, requests < 100. Retention default: 90 days. Viewports default: mobile (375×812), tablet (768×1024), desktop (1440×900). These defaults pre-fill the admin forms so empty submissions still produce a working check.
- **Account-manager assignment.** `Project.assigned_manager_id` is a single FK in MVP. If the team starts covering for each other, promote to many-to-many in a future migration.
