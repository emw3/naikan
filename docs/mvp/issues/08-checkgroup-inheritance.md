# 08 — CheckGroup + inheritance

Status: ready-for-human
Category: enhancement
Type: AFK

## Parent

`docs/mvp/PRD.md`

## What to build

`CheckGroup` entity (per project) with default `interval_seconds`, `alert_routing`, `alert_after_n_fails`. Both `HeartbeatCheck` and (later) `UICheck` carry an optional `group_id`; when a check field is null, the group's default is inherited.

Resolve inheritance inside `config-repo` (return effective config to all consumers) and inside `scheduler` (so the next-run math uses the inherited interval). No call site outside these two modules should ever see a raw `null` interval.

End-to-end demo: an admin creates a CheckGroup "prod-critical" with `interval=300s`; creates two heartbeat checks under it with no interval; both run every 5min. Admin overrides one check's interval to 60s; that one runs every minute, the other still 5min.

## Acceptance criteria

- [x] `CheckGroup` migration; `HeartbeatCheck.group_id` FK added (nullable)
- [x] Admin UI: CheckGroup CRUD under a project; check-edit form lets you pick a group and shows which fields will inherit vs override
- [x] `config-repo.getEffectiveCheck(id)` returns config with inheritance resolved
- [x] `scheduler` consumes effective configs only
- [x] Unit tests on inheritance resolution: no group, group with all defaults, group with partial defaults, full check override
- [x] Integration test: schedule fires inherited interval, then changes after check override

## Blocked by

- #07

## Comments

**Implemented (agent, 2026-06-02).** Branch `worktree-issue-08-checkgroup`.

- **Inheritance model — `null` means inherit.** A `HeartbeatCheck` now stores `null`
  for `intervalSeconds`/`alertAfterNFails` when it should inherit, and carries a nullable
  `groupId`. The pure resolver `resolveEffectiveCheck(check, group)` in
  `packages/config-repo/src/effective.ts` is the single source of the PRD rule
  `effective = check ?? group ?? system` (system defaults: interval 300, alertAfterNFails 1).
  This changed create-time defaulting: omitting an interval used to store `300`; it now
  stores `null` (which still *resolves* to 300 when ungrouped) — effective value unchanged.
  5 unit tests cover the four required cases (no group, all-group-defaults, partial-group,
  full check override) + field preservation.
- **`config-repo`** — `CheckGroup` CRUD (`createGroup`/`updateGroup`/`deleteGroup`/
  `listGroups`/`getGroup`, audited under a new `check_group` entity), plus
  `getEffectiveCheck(id)` and `listEffectiveChecks()` returning the resolved
  `EffectiveHeartbeatCheck` (never a null interval). Cross-project integrity: a check's
  `groupId` must name a group owned by the site's project, else `ValidationError("groupId")`.
  In-memory + pg stores both gained a `groups` sub-store; group delete sets member checks'
  `group_id` null (FK `ON DELETE SET NULL`), project delete cascades its groups. +18 repo tests.
- **`alert_routing`** mirrors the Project routing fields — `{ slackChannel, alertEmails[] }`,
  nullable jsonb on the group, validated with the existing Slack/email validators, surfaced
  on `EffectiveHeartbeatCheck.alertRouting`. **Stored and round-tripped only** — no consumer
  until the alerter (#10). A check has no per-check routing override (PRD), so its effective
  routing is its group's routing (or null).
- **Scheduler stays pure.** `@naikan/scheduler` is unchanged (it already takes a single
  resolved interval per entry). "Scheduler consumes effective configs only" is satisfied by
  the worker tick switching from `repo.listAllChecks()` to `repo.listEffectiveChecks()`.
  2 integration tests: a grouped check with null interval schedules on the group's 300s, and
  a per-check override (60s) changes the cadence — the issue's end-to-end demo, deterministic
  via injected clock.
- **API** — new `createGroupApp` (CheckGroup CRUD, admin-write/auth-read, `ValidationError`→400),
  mounted in `index.ts` + `dev-no-db.ts`. Heartbeat routes pass `groupId` through unchanged;
  added 2 route tests (group assign + clear-to-inherit; cross-project rejection). `dev-no-db`
  seeds a `prod-critical` group (300s, alert-after-2, routing) with a check that inherits it.
- **Web-admin** — `ProjectDetail.svelte` gained a "Check groups" CRUD section; `SiteDetail.svelte`
  gained a group `<select>`, inherit-vs-override hints on the interval/alert fields (blank =
  inherit, shows the inherited value), and an effective-interval + group-tag + "inherited"
  marker in the check list.

**Verification:** `bun test` → **166 pass / 0 fail** (6 pre-existing DB-gated skips; suite up
from 135 in #07). `bun run typecheck` (svelte-check) → 0 errors / 0 warnings. `bun run
build:web` → clean. Migration `1810000000000_check-groups.js` parses; booted `dev-no-db` and
exercised the full demo over HTTP — seeded group resolves (interval 300, afterN 2, routing),
the inheriting check reads `intervalSeconds: null`, a PATCH to 60 overrides, PATCH to null
falls back to inherit.

**DB caveat:** the agent box has no Postgres, so the migration `up`/`down` and the pg-store
`groups` paths were verified by type-check + the offline suite (which uses the in-memory store)
only. Before deploy, on a DB-reachable machine: `bun run migrate` then `bun run smoke`, and
confirm a grouped check accrues CheckRuns on the inherited interval.
