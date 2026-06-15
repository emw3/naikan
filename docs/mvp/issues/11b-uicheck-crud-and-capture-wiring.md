# 11b — UICheck entity + CRUD + worker capture wiring (first end-to-end run)

Status: ready-for-human
Category: enhancement
Type: AFK

## Parent

`docs/mvp/PRD.md`

## What to build

The `UICheck` entity + admin-UI CRUD, the worker job that drives `@naikan/ui-runner` and
persists artifacts, and a "Run now" button. No baseline / no diff / no synthetic signals yet —
those land in #12 and #13. This slice proves the capture path works end-to-end: admin defines a
UI check → clicks Run → 3 full-page PNGs appear in S3/MinIO → visible in the admin UI via
presigned URLs.

`UICheck`: `site_id`, optional `group_id`, `path`, `viewports[]` (default
`[mobile, tablet, desktop]`), `selectors[]`, `ignore_regions[]`, `perf_budget`,
`diff_threshold`, per-signal severity fields (stored but unused yet), `baseline_image_ref?`.

**Artifact persistence:** the worker writes the per-viewport PNGs via `baseline-store`
(`artifactKeys.runScreenshot`), then writes a per-run **`manifest.json`** (new
`artifactKeys.runManifest(projectId, checkId, runId)` builder — extends ADR-0002's scheme under
the `runs/<runId>/` subtree, so it is reaped with the run). The `CheckRun.artifactsRef` text
column stores the **manifest key**. The manifest records what the run produced so historical
runs render correctly even if the check's `viewports[]` is edited later:

```json
{ "runId": "…", "viewports": ["mobile","tablet","desktop"],
  "screenshots": { "mobile": "…/mobile.png", "tablet": "…", "desktop": "…" } }
```
(#12 adds `"diffs": {…}`, #13 adds `"signals": {…}` to the same manifest.)

**Run now:** for UI checks, "Run now" **enqueues a one-shot worker job** — it does NOT run
inline in the Bun `api` (Playwright is Node-only / unstable on Bun, ADR-0001/ADR-0006). This
diverges from heartbeat run-now, which stays synchronous in the api.

## Acceptance criteria

- [x] `UICheck` migration written (`migrations/1840000000000_ui-checks.js`; entity fields above;
      `check_runs.artifacts_ref` already exists). NB: authored + module-validated + column-aligned
      with `pg-store`; `bun migrate` not run here (no DB reachable in the build env — see Comments).
- [x] `artifactKeys.runManifest(projectId, checkId, runId)` added to `baseline-store`; tests for it
- [x] Worker UI job handler (`apps/worker/src/ui-job.ts`, mirroring `job.ts`) invokes
      `runUI`, writes per-viewport PNGs + `manifest.json` via `baseline-store`, writes a
      `CheckRun` (`check_type='uicheck'`) with `artifactsRef` = the manifest key
- [x] Admin UI: UICheck CRUD; "Run now" enqueues the worker job (not synchronous — 202 + `add_job`)
- [x] Detail page renders the 3 viewport screenshots via presigned URLs (read from the manifest)
- [x] Tests: worker job handler with a fake `runUI` asserts PNG keys + manifest are written and
      the CheckRun references the manifest key; CRUD + run-now route tests

## Blocked by

- #11a (the `capture` + `ui-runner` packages)
- #05 (Site), #04 (artifact store / `baseline-store`)

## Notes

- Supersedes the old #11. The sentinel-copy / `SYNC.md` criterion is gone (see #11a).
- `baseline_image_ref` / diff_threshold / per-signal severity fields are stored-but-unused here;
  consumed in #12 (diff) and #13 (signals).

## Comments

### Agent — built on branch `worktree-issue-11b-uicheck-crud-capture`

Implemented TDD, layer by layer. Full suite: **266 pass / 0 fail** (6 pre-existing MinIO/Playwright
skips); `svelte-check` 0 errors; Vite SPA build OK; all touched source typechecks clean.

What landed:
- **ui-runner** — `VIEWPORTS` (PRD sizes) + `resolveViewports(labels)`; the worker maps a UICheck's
  stored viewport *labels* to capture sizes here, keeping the worker thin.
- **baseline-store** — `artifactKeys.runManifest(projectId, checkId, runId)` →
  `…/runs/<runId>/manifest.json`, inside the run subtree so it's reaped with the run (ADR-0002).
- **config-repo** — `UICheck` entity (types + `Severity`/`PerfBudget`), `ConfigStore.uichecks`,
  in-memory + pg stores, repo CRUD with validation/PRD-defaults, audit `entityType: 'uicheck'`,
  site-cascade + group-SET-NULL. 20 new unit tests.
- **migration** `1840000000000_ui-checks.js` — `ui_checks` mirroring `heartbeat_checks` + uicheck
  fields (`viewports[]`, `selectors[]`, `ignore_regions[]`, `perf_budget` jsonb, `diff_threshold`,
  `severity_*`, `baseline_image_ref`). `check_runs.artifacts_ref` unchanged.
- **worker** `ui-job.ts` — `runUIJob` drives `runUI` at `baseUrl+path`, writes per-viewport PNGs +
  `manifest.json` via `baseline-store`, records a `uicheck` `CheckRun` with `artifactsRef`=manifest
  key. Wired `uicheck-run` into the graphile-worker task list (store built lazily so a no-S3 worker
  still boots).
- **api** `uicheck/routes.ts` — CRUD + `POST /run` that **enqueues** (`202`, `graphile_worker`
  `add_job`, dynamic-imported so a DB-less/Bun boot stays safe) and a run-detail route that presigns
  the run's screenshots from the manifest (degrades to empty set if the manifest is unreadable).
- **web-admin** — UICheck CRUD section in `SiteDetail`, `UICheckDetail.svelte` rendering the
  per-viewport screenshots via presigned URLs, `#/uichecks/:id` route, API project.

⚠ **Human action — migration not applied here.** The build env has no reachable Postgres (no Docker,
`DATABASE_URL` unset). The migration module loads clean and its columns are 1:1 with `pg-store`, but
`bun migrate` must be run against a live DB before the end-to-end run-now → 3 PNGs → admin UI flow
works. After migrating + `docker compose up worker` (with `S3_*` env), verify the manual end-to-end
acceptance (admin defines a UI check → Run now → 3 PNGs in MinIO → visible via presigned URLs).
