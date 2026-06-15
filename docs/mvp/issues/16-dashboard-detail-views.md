# 16 — Dashboard detail views

Status: ready-for-agent
Category: enhancement
Type: AFK

## Parent

`docs/mvp/PRD.md`

## What to build

Read-only dashboard surfaces consumed by both managers and viewers, and deep-linked from emails / Slack messages:

- **Project overview** — list of all checks under a project with last-24h pass/fail summary, count of open incidents.
- **HeartbeatCheck detail** — last 24h timeline (one row per run with status + latency); badge for current state; list of recent incidents.
- **UICheck detail** — per-viewport side-by-side viewer for the latest run (covered in #12, presented here in detail page form) + per-signal status with detail + last 14 runs as a stripe.
- **Incidents view** — open incidents across the user's projects (managers: only assigned), with opened-at + duration so far.

These read paths must not require new write logic; they consume `CheckRun` and `Incident` rows already populated by #07–#14.

## Acceptance criteria

- [x] Project overview page; permissions: Admin sees all, Viewer sees all, Manager sees only assigned (the assignment scoping is single-FK, low-effort to enforce)
- [x] HeartbeatCheck detail page with 24h timeline + recent incidents
- [x] UICheck detail page with per-viewport viewer + per-signal status + run-stripe
- [x] Incidents view filterable by open/closed
- [x] All deep-links from #15 digest resolve to the correct page
- [x] Tests: integration tests on the API surface; UI tested with one Playwright smoke spec ("manager logs in, lands on overview, sees their project")

## Blocked by

- #09, #12

## Comments

### Implemented (branch `worktree-issue-16-dashboard-detail-views`)

**Manager scoping decision.** Roles are flat (`admin`|`viewer`); a "manager" is a
user who is a Project's `assignedManagerId`. Reconciled the issue ("Viewer sees
all, Manager sees only assigned") with PRODUCT.md into one rule in
`apps/api/src/dashboard/scope.ts`: admin → all; a user assigned to ≥1 project →
only those; a user with 0 assignments → all. Applied to `/api/projects`,
`/api/projects/:id`, and (for consistency) the site reads, plus all four dashboard
endpoints.

**Routing decision.** The digest (#15) and incident alerter (#10) deep-link to
`/#/projects/:id`. That route now renders the new read-only **Project overview**
for every role; the admin config page (former ProjectDetail) moved to
`/#/projects/:id/config` behind a "Manage" button — no churn to #15/#10 URLs.

**API (read-only, consumes existing CheckRun/Incident rows):**
`GET /api/projects/:id/overview`, `GET /api/checks/:id/detail`,
`GET /api/uichecks/:id/detail`, `GET /api/incidents?status=open|closed` —
`apps/api/src/dashboard/routes.ts`.

**UI:** `ProjectOverview.svelte`, `HeartbeatDetail.svelte` (24h stripe + run
rows + recent incidents), `IncidentsView.svelte` (open/resolved toggle), and a
state badge + last-14 run-stripe + recent-incidents added to `UICheckDetail`.
New `#/checks/:id` and `#/incidents` routes + an Incidents nav item.

**Tests:** scope unit tests, config + dashboard API integration tests, and a
Playwright smoke (`apps/api/e2e/overview.smoke.ts`, `bun run --filter @naikan/api
test:e2e`) driving a real Chromium: manager logs in → lands on their project
overview → sees only their project. Full suite green (389 pass / 0 fail);
web typechecks + builds.
