# 05 — Project + Site CRUD

Status: ready-for-human
Category: enhancement
Type: AFK

## Parent

`docs/mvp/PRD.md`

## What to build

The Project and Site domain entities with full admin-UI CRUD. `Project` carries name, contacts (free-text), Slack channel, alert email list, retention-days, and `assigned_manager_id` (FK to `User`). `Site` carries `project_id` and `base_url`. Implement the `config-repo` module as the only DB-access path for these entities.

End-to-end demo: an admin creates a Project, assigns themselves as manager, attaches a Site with base URL, edits, deletes; a Viewer sees the same data read-only; the audit log records each mutation.

## Acceptance criteria

- [x] `Project` and `Site` migrations applied
- [x] `AuditLog(id, user_id, entity_type, entity_id, action, diff_json, created_at)` migration applied
- [x] `config-repo` exposes typed CRUD for Project and Site; all writes log to `AuditLog`
- [x] Hono routes: list/get/create/update/delete for Project and Site, role-gated
- [x] SPA: projects list, project detail with sites tab, forms for create/edit
- [x] Validation: required fields, retention-days positive, email format, slack channel format
- [x] Tests: integration tests on the API for happy-path CRUD and validation; one tests the audit-log row is written

## Blocked by

- #03

## Comments

### Agent — implemented (merged to `master` @ 9b8bec6)

All acceptance criteria met:

- [x] Migration `migrations/1790000000000_projects-sites-audit.js` — `projects`, `sites`, `audit_log`. `projects.retention_days` CHECK > 0; `assigned_manager_id` → users ON DELETE SET NULL; `sites.project_id` → projects ON DELETE CASCADE; `audit_log.diff_json` jsonb, indexed by `(entity_type, entity_id)`. Applied + verified against live Postgres.
- [x] `packages/config-repo` (`@naikan/config-repo`) — new shared deep module, the only DB-access path for these entities (the worker needs it later too). `createConfigRepo(store)` owns validation and writes a before/after `AuditLog` row attributed to the acting user on every mutation. `ConfigStore` persistence is injected: `InMemoryConfigStore` (tests / no-DB dev) and `createPgConfigStore` (raw SQL, lazy connection) — mirrors the auth module's split.
- [x] Hono routes `apps/api/src/config/routes.ts` — list/get/create/update/delete for Project + Site. Reads open to any session (Viewer included); writes admin-only. `ValidationError` → 400 with the offending field. Wired pg in `index.ts`, in-memory + a seeded sample in `dev-no-db.ts`.
- [x] SPA — `Projects.svelte` (list + inline create form), `ProjectDetail.svelte` (edit form + sites section: add/edit/delete), `Shell.svelte` hash routing for `#/projects/:id`, typed project in `lib/api.ts`. Viewers see everything read-only (no New/Edit/Delete). Editorial style per the project's UI direction. ("Sites tab" rendered as a section on the detail page — matches the no-chrome aesthetic.)
- [x] Validation in `config-repo`: required name, positive integer retention, email format on each alert email, `#channel` Slack format, http(s) base URL.
- [x] Tests: 23 `config-repo` unit tests + 13 API integration tests (CRUD, role gating, validation, audit-row-written). Full suite: 70 pass / 6 skip / 0 fail. Web typecheck clean.

Verified end-to-end through the prod pg-store path (the SQL that has no unit test): create/update/delete project + add site, audit rows written with correct diffs, site cascade on project delete. Manual UI pass via `bun run dev` against Postgres.

Design calls: Project/Site **hard-delete** (sites cascade) since the PRD data model has no `deleted_at` for them; Slack channel validated as `#channel-name`.
