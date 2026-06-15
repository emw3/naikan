# 03 — Auth + users

Status: ready-for-human
Category: enhancement
Type: AFK

## Parent

`docs/mvp/PRD.md`

## What to build

Email/password authentication with session cookies, the `User` table, the two flat roles (`admin`, `viewer`), and an admin-only Users CRUD screen so the first admin can be seeded and additional users created from the UI.

End-to-end demo: a seed script creates the first admin from env vars; logging in via the SPA stores a session cookie; protected routes return 401/403 appropriately; admins see and can create new users with a role; viewers don't see the Users screen.

## Acceptance criteria

- [ ] `User(id, email, password_hash, role, created_at)` migration applied
- [ ] Password hashing via argon2 or bcrypt
- [ ] `auth` module exposes `login(email, password)`, session cookie issuance, `requireRole(role)` middleware
- [ ] Seed script creates the first admin from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`
- [ ] SPA login page; logged-in shell with user identity + logout
- [ ] Admin-only Users screen: list, create, change role, soft-delete
- [ ] Viewer role cannot reach admin-only API routes (403)
- [ ] Tests: unit on `auth` (hashing, session lifecycle); integration on protected route 401/403/200

## Blocked by

- #01

## Comments

### Agent — implemented (branch `worktree-issue-03-auth-users`)

All acceptance criteria met:

- [x] `users` migration (id uuid, email, password_hash, role, created_at, + `deleted_at` for soft-delete) and a `sessions` table — `migrations/1780000000000_users-and-sessions.js`.
- [x] Password hashing via argon2id (`Bun.password`) — `apps/api/src/auth/password.ts`.
- [x] `auth` module: `login`, session-cookie issuance, `requireAuth`/`requireRole` middleware — `apps/api/src/auth/{service,middleware,routes}.ts`. Stores are injected (`UserStore`/`SessionStore`); in-memory for tests, Postgres (`pg-stores.ts`) in prod.
- [x] Seed script — `scripts/seed-admin.ts` (`bun run seed:admin`), idempotent.
- [x] SPA login page + shell with identity & logout — `apps/web-admin/src/{Login,Shell}.svelte`.
- [x] Admin-only Users screen (list / create / change role / soft-delete) — `Users.svelte`.
- [x] Viewer blocked from admin routes (403) and from the Users nav.
- [x] Tests: hashing + session lifecycle (unit) and 401/403/200 (integration) — 26 auth tests, all green.

CI gained a `test` job (`bun test`) and a `seed:admin` step in the `migrate` job, so the real Postgres path (migration up/down + Pg user insert) is exercised in CI.

**Not verified locally:** the live-Postgres path (migration apply, seed, Pg-store queries) — Docker/Postgres unavailable in the dev sandbox. Logic is covered by in-memory integration tests and will run against real Postgres in the CI `migrate` job. The repo has no git remote, so no PR was opened.
