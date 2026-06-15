# CheckGroup + inheritance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-project `CheckGroup` whose `interval`, `alert routing`, and `alert-after-N-fails` defaults are inherited by its `HeartbeatCheck`s when the check leaves a field blank, with inheritance resolved inside `config-repo` and consumed (resolved) by the scheduler tick — so no call site outside those two modules ever sees a raw `null` interval.

**Architecture:** A pure resolver (`resolveEffectiveCheck(check, group)`) lives in `config-repo` and is the single source of the `check ?? group ?? system-default` rule (PRD behavioural rule). `HeartbeatCheck` gains a nullable `groupId` and its `intervalSeconds`/`alertAfterNFails` become nullable (null = inherit). `config-repo` exposes `getEffectiveCheck(id)` and `listEffectiveChecks()` returning the resolved `EffectiveHeartbeatCheck`; the worker tick feeds `listEffectiveChecks()` into `@naikan/scheduler` so the next-run math uses inherited intervals. CheckGroup CRUD is added to `config-repo`, the API (a new `group` route module), and the admin SPA (a "Check groups" section under a project + a group picker / inherit-vs-override hints on the check-edit form). The pure `@naikan/scheduler` package is unchanged — it already takes a single resolved interval per entry.

**Tech Stack:** TypeScript (strip-only–safe — no `enum`, no constructor parameter properties; see ADR-0001/0005), Bun test runner (`bun test`), Hono (API), `postgres` raw SQL + `node-pg-migrate` (DB), Svelte 5 runes (web-admin). Kernel packages (`packages/*`) stay runtime-agnostic.

---

## Design decisions & assumptions

1. **`null` means inherit.** A `HeartbeatCheck` stores `null` for `intervalSeconds`/`alertAfterNFails` when it should inherit; `resolveEffectiveCheck` applies `check ?? group ?? system-default`. This **changes create-time defaulting**: previously omitting `intervalSeconds` stored `300`; now it stores `null` (which still *resolves* to `300` when there is no group). The effective value is unchanged; the raw stored value differs. One existing test (`createCheck applies sensible defaults`) is updated accordingly in Task 4.
2. **System defaults:** interval `300`, alertAfterNFails `1` (unchanged from #06). They now live only in `effective.ts`.
3. **`alert_routing` shape (confirmed with maintainer):** `CheckGroup.defaultAlertRouting` mirrors the `Project` routing fields — `{ slackChannel: string | null; alertEmails: string[] }`, stored as nullable `jsonb`, validated with the existing Slack/email validators, surfaced on `EffectiveHeartbeatCheck.alertRouting`. **No consumer until the alerter (#10);** it is stored and round-tripped only. A `HeartbeatCheck` has *no* per-check routing override (PRD data model), so a check's effective routing is simply its group's routing (or `null`).
4. **Scheduler ownership:** the pure `@naikan/scheduler` package is **not** modified. "Scheduler consumes effective configs only" is satisfied by switching the worker tick from `repo.listAllChecks()` to `repo.listEffectiveChecks()`, whose entries carry resolved (never-null) intervals. `listAllChecks` (raw) is retained as a legitimate accessor.
5. **Group deletion** sets dependent checks' `group_id` to `null` (FK `ON DELETE SET NULL`); those checks fall back to the system default. Deleting a *project* cascades its groups (FK `ON DELETE CASCADE`).
6. **`groupId` integrity:** a check's `groupId` must reference a group owned by the **same project** as the check's site. Cross-project assignment is rejected with `ValidationError("groupId", …)`. Enforced in the repo (it has the store); the pg FK also enforces existence.
7. **No Svelte unit tests exist** in this repo; UI tasks are gated by `bun run typecheck` (svelte-check) plus a manual `dev-no-db` walkthrough. The `pg-store` has no unit tests (it mirrors the in-memory store and is covered by `scripts/smoke.ts` against real Postgres); its tasks are gated by `bun test` (which does not touch Postgres) + typecheck, with the smoke script noted as the integration gate.

## File structure

**Modified — `packages/config-repo`:**
- `src/types.ts` — add `AlertRouting`, `CheckGroup`, `CheckGroupInput`, `CheckGroupPatch`, `EffectiveHeartbeatCheck`; make `HeartbeatCheck.intervalSeconds`/`alertAfterNFails` nullable + add `groupId`; add `groupId` to `HeartbeatCheckInput`/`HeartbeatCheckPatch`; add `"check_group"` to `AuditLogEntry.entityType`; add a `groups` sub-store to `ConfigStore`.
- `src/effective.ts` *(new)* — `resolveEffectiveCheck` + system-default constants.
- `src/effective.test.ts` *(new)* — pure resolver unit tests (the 4 inheritance cases + routing).
- `src/in-memory-store.ts` — `groups` sub-store; group cascade on project delete; `SET NULL` on group delete.
- `src/pg-store.ts` — `groups` sub-store; map nullable check columns + `group_id`.
- `src/repo.ts` — group CRUD + audit; `getEffectiveCheck`/`listEffectiveChecks`; nullable check normalization; `groupId` validation; `groupId` in `CHECK_FIELDS`.
- `src/groups.test.ts` *(new)* — repo-level group CRUD, validation, audit, effective resolution, cascade.
- `src/checks.test.ts` — update the defaults test for the null-means-inherit change.
- `src/index.ts` — export the new public types + the resolver.

**Modified — `migrations`:**
- `1810000000000_check-groups.js` *(new)* — `check_groups` table; `heartbeat_checks.group_id`; make `interval_seconds`/`alert_after_n_fails` nullable.

**Modified — `apps/worker`:**
- `src/tick.ts` — consume `listEffectiveChecks()`.
- `src/worker.test.ts` — integration test: inherited interval, then per-check override.

**Modified — `apps/api`:**
- `src/group/routes.ts` *(new)* — `createGroupApp` (CheckGroup CRUD).
- `src/group/routes.test.ts` *(new)* — route auth + CRUD + validation tests.
- `src/heartbeat/routes.ts` — accept `groupId` + nullable interval/alertAfterNFails (pass-through; verify, no code change expected).
- `src/heartbeat/routes.test.ts` — add a group-inheritance route test.
- `src/index.ts` + `src/dev-no-db.ts` — mount `createGroupApp`; seed a sample group in dev-no-db.

**Modified — `apps/web-admin`:**
- `src/lib/api.ts` — `CheckGroup`/`AlertRouting`/`CheckGroupInput` types + group fns; nullable check fields + `groupId`.
- `src/ProjectDetail.svelte` — "Check groups" section with inline CRUD.
- `src/SiteDetail.svelte` — group `<select>`; inherit-vs-override interval/alertAfterNFails inputs; effective-interval display.

---

## Task 1: Pure inheritance resolver + domain types (config-repo)

**Files:**
- Modify: `packages/config-repo/src/types.ts`
- Create: `packages/config-repo/src/effective.ts`
- Test: `packages/config-repo/src/effective.test.ts`

- [ ] **Step 1: Add the new domain types to `types.ts`**

In `packages/config-repo/src/types.ts`, replace the `HeartbeatCheck`, `HeartbeatCheckInput`, and `HeartbeatCheckPatch` definitions (currently lines 48–83) with the versions below, and add the new `AlertRouting` / `CheckGroup` / `EffectiveHeartbeatCheck` types. Insert the `AlertRouting` + `CheckGroup` block immediately above `HeartbeatCheck`:

```ts
/**
 * Alert routing policy carried by a CheckGroup (issue #08). Shape mirrors the
 * Project routing fields; consumed by the alerter (#10). Stored as jsonb.
 */
export interface AlertRouting {
  /** Slack channel for this group's alerts, e.g. `#prod-critical`. Null when unset. */
  slackChannel: string | null;
  /** Recipients for this group's alert email. May be empty. */
  alertEmails: string[];
}

/**
 * A reusable policy (per project) that HeartbeatChecks inherit defaults from
 * (issue #08). Each default is nullable: a null default means "fall through to
 * the system default" (`check ?? group ?? system`).
 */
export interface CheckGroup {
  id: string;
  projectId: string;
  name: string;
  /** Default run interval inherited by member checks that leave it null. */
  defaultIntervalSeconds: number | null;
  /** Default alert routing inherited by member checks (no per-check override). */
  defaultAlertRouting: AlertRouting | null;
  /** Default consecutive-fails-to-open inherited by member checks that leave it null. */
  defaultAlertAfterNFails: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields accepted when creating a CheckGroup. */
export interface CheckGroupInput {
  projectId: string;
  name: string;
  defaultIntervalSeconds?: number | null;
  defaultAlertRouting?: AlertRouting | null;
  defaultAlertAfterNFails?: number | null;
}

/** Updatable CheckGroup fields (the parent project is fixed once created). */
export type CheckGroupPatch = Partial<Omit<CheckGroupInput, "projectId">>;

/**
 * A heartbeat check under a Site (issue #06). `groupId`, `intervalSeconds`, and
 * `alertAfterNFails` are nullable: when null they inherit from the check's
 * CheckGroup (issue #08). Resolve with `resolveEffectiveCheck` — never read the
 * raw nullable fields for scheduling/alerting.
 */
export interface HeartbeatCheck {
  id: string;
  siteId: string;
  /** FK to the CheckGroup this check inherits from, or null (no group). */
  groupId: string | null;
  /** Request path appended to the site base URL, e.g. `/health`. Starts with `/`. */
  path: string;
  /** Optional response-body assertion, or null when not checked. */
  bodyAssertion: BodyAssertion | null;
  /** Inspect the TLS certificate expiry (https only). */
  certCheck: boolean;
  /** Resolve the hostname via DNS. */
  dnsCheck: boolean;
  /** How often the scheduler runs this check; null = inherit from the group. */
  intervalSeconds: number | null;
  /** Consecutive failures before an incident opens (#09); null = inherit. */
  alertAfterNFails: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields accepted when creating a HeartbeatCheck. */
export interface HeartbeatCheckInput {
  siteId: string;
  groupId?: string | null;
  path?: string;
  bodyAssertion?: BodyAssertion | null;
  certCheck?: boolean;
  dnsCheck?: boolean;
  intervalSeconds?: number | null;
  alertAfterNFails?: number | null;
}

/** Updatable HeartbeatCheck fields (the parent site is fixed once created). */
export type HeartbeatCheckPatch = Partial<Omit<HeartbeatCheckInput, "siteId">>;

/**
 * A HeartbeatCheck with inheritance resolved (issue #08): `intervalSeconds` and
 * `alertAfterNFails` are never null, and `alertRouting` carries the group's
 * routing (or null when no group). This is what the scheduler/dashboards read.
 */
export interface EffectiveHeartbeatCheck
  extends Omit<HeartbeatCheck, "intervalSeconds" | "alertAfterNFails"> {
  intervalSeconds: number;
  alertAfterNFails: number;
  alertRouting: AlertRouting | null;
}
```

- [ ] **Step 2: Extend `AuditLogEntry.entityType` and add a `groups` sub-store**

In `types.ts`, update the `AuditLogEntry.entityType` union (currently `"project" | "site" | "heartbeat_check"`) to include `"check_group"`:

```ts
  entityType: "project" | "site" | "heartbeat_check" | "check_group";
```

Then add a `groups` sub-store to the `ConfigStore` interface, immediately after the `sites:` block:

```ts
  groups: {
    listByProject(projectId: string): Promise<CheckGroup[]>;
    get(id: string): Promise<CheckGroup | null>;
    insert(group: CheckGroup): Promise<CheckGroup>;
    update(id: string, patch: CheckGroupPatch): Promise<CheckGroup | null>;
    /** Hard-deletes the group; member checks' group_id is set null by the caller/FK. Returns the deleted row, or null. */
    remove(id: string): Promise<CheckGroup | null>;
  };
```

- [ ] **Step 3: Write the failing resolver test**

Create `packages/config-repo/src/effective.test.ts`:

```ts
import { expect, test } from "bun:test";
import { resolveEffectiveCheck } from "./effective.ts";
import type { CheckGroup, HeartbeatCheck } from "./types.ts";

function check(over: Partial<HeartbeatCheck> = {}): HeartbeatCheck {
  return {
    id: "c1",
    siteId: "s1",
    groupId: null,
    path: "/health",
    bodyAssertion: null,
    certCheck: false,
    dnsCheck: false,
    intervalSeconds: null,
    alertAfterNFails: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

function group(over: Partial<CheckGroup> = {}): CheckGroup {
  return {
    id: "g1",
    projectId: "cl1",
    name: "prod-critical",
    defaultIntervalSeconds: null,
    defaultAlertRouting: null,
    defaultAlertAfterNFails: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

test("no group: nulls fall through to system defaults", () => {
  const e = resolveEffectiveCheck(check(), null);
  expect(e.intervalSeconds).toBe(300);
  expect(e.alertAfterNFails).toBe(1);
  expect(e.alertRouting).toBeNull();
});

test("group with all defaults: check inherits every group default", () => {
  const g = group({
    defaultIntervalSeconds: 600,
    defaultAlertAfterNFails: 3,
    defaultAlertRouting: { slackChannel: "#prod", alertEmails: ["a@x.test"] },
  });
  const e = resolveEffectiveCheck(check({ groupId: g.id }), g);
  expect(e.intervalSeconds).toBe(600);
  expect(e.alertAfterNFails).toBe(3);
  expect(e.alertRouting).toEqual({ slackChannel: "#prod", alertEmails: ["a@x.test"] });
});

test("group with partial defaults: unset group fields fall through to system", () => {
  const g = group({ defaultIntervalSeconds: 600, defaultAlertAfterNFails: null });
  const e = resolveEffectiveCheck(check({ groupId: g.id }), g);
  expect(e.intervalSeconds).toBe(600); // from group
  expect(e.alertAfterNFails).toBe(1); // group null -> system
});

test("full check override: check values win over the group", () => {
  const g = group({ defaultIntervalSeconds: 600, defaultAlertAfterNFails: 3 });
  const e = resolveEffectiveCheck(
    check({ groupId: g.id, intervalSeconds: 60, alertAfterNFails: 5 }),
    g,
  );
  expect(e.intervalSeconds).toBe(60);
  expect(e.alertAfterNFails).toBe(5);
});

test("preserves the non-inherited check fields", () => {
  const e = resolveEffectiveCheck(check({ path: "/up", certCheck: true }), null);
  expect(e.path).toBe("/up");
  expect(e.certCheck).toBe(true);
  expect(e.id).toBe("c1");
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `bun test packages/config-repo/src/effective.test.ts`
Expected: FAIL — `Cannot find module './effective.ts'` (resolver not written yet).

- [ ] **Step 5: Write the resolver**

Create `packages/config-repo/src/effective.ts`:

```ts
/**
 * Pure CheckGroup inheritance resolution (issue #08).
 *
 * The single source of the PRD rule `effective = check ?? group ?? system`.
 * No DB, no clock — the check and its group (or null) are passed in, so the
 * decision is deterministic and unit-testable. The repo composes this over the
 * store (`getEffectiveCheck` / `listEffectiveChecks`); the scheduler tick reads
 * only the resolved result, so no consumer ever sees a raw null interval.
 */
import type { CheckGroup, EffectiveHeartbeatCheck, HeartbeatCheck } from "./types.ts";

/** System fallback when neither the check nor its group sets an interval. */
export const SYSTEM_DEFAULT_INTERVAL_SECONDS = 300;
/** System fallback when neither the check nor its group sets alert-after-N-fails. */
export const SYSTEM_DEFAULT_ALERT_AFTER_N_FAILS = 1;

/** Resolve a check's effective config against its group (or null when ungrouped). */
export function resolveEffectiveCheck(
  check: HeartbeatCheck,
  group: CheckGroup | null,
): EffectiveHeartbeatCheck {
  return {
    ...check,
    intervalSeconds:
      check.intervalSeconds ?? group?.defaultIntervalSeconds ?? SYSTEM_DEFAULT_INTERVAL_SECONDS,
    alertAfterNFails:
      check.alertAfterNFails ??
      group?.defaultAlertAfterNFails ??
      SYSTEM_DEFAULT_ALERT_AFTER_N_FAILS,
    alertRouting: group?.defaultAlertRouting ?? null,
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test packages/config-repo/src/effective.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/config-repo/src/types.ts packages/config-repo/src/effective.ts packages/config-repo/src/effective.test.ts
git commit -m "feat(config-repo): CheckGroup types + pure inheritance resolver (#08)"
```

---

## Task 2: In-memory store — groups sub-store + cascade

**Files:**
- Modify: `packages/config-repo/src/in-memory-store.ts`

(No standalone test: the store is exercised through the repo tests in Tasks 3–4. This task only needs to type-check and keep existing tests green.)

- [ ] **Step 1: Import the group types**

In `packages/config-repo/src/in-memory-store.ts`, extend the type import block (currently lines 6–16) to include `CheckGroup` and `CheckGroupPatch`:

```ts
import type {
  AuditLogEntry,
  CheckGroup,
  CheckGroupPatch,
  CheckRun,
  Project,
  ProjectPatch,
  ConfigStore,
  HeartbeatCheck,
  HeartbeatCheckPatch,
  Site,
  SitePatch,
} from "./types.ts";
```

- [ ] **Step 2: Add a groups map and update the project cascade**

Add the groups map next to the other maps (after `checksById`):

```ts
  private readonly groupsById = new Map<string, CheckGroup>();
```

Update `projects.remove` so deleting a project also drops its groups (mirrors the FK `projects ON DELETE CASCADE`). Replace the existing `remove` body in the `projects` block with:

```ts
    remove: (id: string): Promise<Project | null> => {
      const c = this.projectsById.get(id);
      if (!c) return Promise.resolve(null);
      this.projectsById.delete(id);
      // Cascade sites — and each site's checks (mirrors the FK ON DELETE CASCADE).
      for (const [sid, s] of this.sitesById) {
        if (s.projectId === id) this.cascadeSite(sid);
      }
      // Cascade the project's check groups (FK ON DELETE CASCADE).
      for (const [gid, g] of this.groupsById) {
        if (g.projectId === id) this.groupsById.delete(gid);
      }
      return Promise.resolve(clone(c));
    },
```

- [ ] **Step 3: Add the `groups` sub-store**

Add a `groups` sub-store after the `sites` block (before `checks`):

```ts
  readonly groups = {
    listByProject: (projectId: string): Promise<CheckGroup[]> =>
      Promise.resolve(
        [...this.groupsById.values()]
          .filter((g) => g.projectId === projectId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map(cloneGroup),
      ),

    get: (id: string): Promise<CheckGroup | null> => {
      const g = this.groupsById.get(id);
      return Promise.resolve(g ? cloneGroup(g) : null);
    },

    insert: (group: CheckGroup): Promise<CheckGroup> => {
      this.groupsById.set(group.id, cloneGroup(group));
      return Promise.resolve(cloneGroup(group));
    },

    update: (id: string, patch: CheckGroupPatch): Promise<CheckGroup | null> => {
      const g = this.groupsById.get(id);
      if (!g) return Promise.resolve(null);
      const next: CheckGroup = { ...g, ...patch, updatedAt: this.now() };
      this.groupsById.set(id, next);
      return Promise.resolve(cloneGroup(next));
    },

    remove: (id: string): Promise<CheckGroup | null> => {
      const g = this.groupsById.get(id);
      if (!g) return Promise.resolve(null);
      this.groupsById.delete(id);
      // Member checks fall back to no group (mirrors the FK ON DELETE SET NULL).
      for (const [cid, c] of this.checksById) {
        if (c.groupId === id) this.checksById.set(cid, { ...c, groupId: null });
      }
      return Promise.resolve(cloneGroup(g));
    },
  };
```

- [ ] **Step 4: Add the `cloneGroup` helper**

Add next to `cloneCheck` at the bottom of the file:

```ts
/** Clone a group, deep-copying the nested routing so callers can't mutate it in place. */
function cloneGroup(g: CheckGroup): CheckGroup {
  return {
    ...g,
    defaultAlertRouting: g.defaultAlertRouting
      ? { ...g.defaultAlertRouting, alertEmails: [...g.defaultAlertRouting.alertEmails] }
      : null,
  };
}
```

- [ ] **Step 5: Verify it type-checks and existing tests still pass**

Run: `bun test packages/config-repo`
Expected: PASS — existing config-repo tests stay green (the store compiles with the new `groups` member; the nullable `HeartbeatCheck` fields are still accepted by the in-memory CRUD). Note: if you run before Task 4, the `checks.test.ts` defaults test still passes against the *unchanged* repo; Task 4 updates it.

- [ ] **Step 6: Commit**

```bash
git add packages/config-repo/src/in-memory-store.ts
git commit -m "feat(config-repo): in-memory groups sub-store + project/group cascade (#08)"
```

---

## Task 3: Repo — CheckGroup CRUD + audit + effective accessors

**Files:**
- Modify: `packages/config-repo/src/repo.ts`
- Test: `packages/config-repo/src/groups.test.ts`

- [ ] **Step 1: Write the failing group CRUD test**

Create `packages/config-repo/src/groups.test.ts`:

```ts
import { beforeEach, expect, test } from "bun:test";
import { createConfigRepo, ValidationError, type ConfigRepo } from "./repo.ts";
import { InMemoryConfigStore } from "./in-memory-store.ts";
import type { Actor } from "./types.ts";

let repo: ConfigRepo;
let projectId: string;
const actor: Actor = { id: "user-1" };

beforeEach(async () => {
  repo = createConfigRepo(new InMemoryConfigStore());
  const project = await repo.createProject({ name: "Acme" }, actor);
  projectId = project.id;
});

// ---- create + defaults ----

test("createGroup stores and returns a group with id + timestamps", async () => {
  const g = await repo.createGroup({ projectId, name: "prod-critical" }, actor);
  expect(g.id).toBeTruthy();
  expect(g.projectId).toBe(projectId);
  expect(g.name).toBe("prod-critical");
  expect(g.defaultIntervalSeconds).toBeNull();
  expect(g.defaultAlertRouting).toBeNull();
  expect(g.defaultAlertAfterNFails).toBeNull();
  expect(g.createdAt).toBeInstanceOf(Date);
});

test("createGroup accepts defaults including routing", async () => {
  const g = await repo.createGroup(
    {
      projectId,
      name: "prod",
      defaultIntervalSeconds: 600,
      defaultAlertAfterNFails: 3,
      defaultAlertRouting: { slackChannel: "#prod", alertEmails: ["a@x.test"] },
    },
    actor,
  );
  expect(g.defaultIntervalSeconds).toBe(600);
  expect(g.defaultAlertRouting).toEqual({ slackChannel: "#prod", alertEmails: ["a@x.test"] });
});

test("listGroups returns groups under a project", async () => {
  await repo.createGroup({ projectId, name: "a" }, actor);
  await repo.createGroup({ projectId, name: "b" }, actor);
  expect(await repo.listGroups(projectId)).toHaveLength(2);
});

// ---- validation ----

test("createGroup requires a name", async () => {
  const err = await repo.createGroup({ projectId, name: "  " }, actor).catch((e) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).field).toBe("name");
});

test("createGroup rejects a non-positive default interval", async () => {
  await expect(
    repo.createGroup({ projectId, name: "x", defaultIntervalSeconds: 0 }, actor),
  ).rejects.toBeInstanceOf(ValidationError);
});

test("createGroup rejects an invalid slack channel in routing", async () => {
  const err = await repo
    .createGroup(
      { projectId, name: "x", defaultAlertRouting: { slackChannel: "prod", alertEmails: [] } },
      actor,
    )
    .catch((e) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).field).toBe("slackChannel");
});

// ---- update / delete ----

test("updateGroup applies a partial patch and bumps updatedAt", async () => {
  const g = await repo.createGroup({ projectId, name: "x" }, actor);
  const u = await repo.updateGroup(g.id, { defaultIntervalSeconds: 120 }, actor);
  expect(u?.defaultIntervalSeconds).toBe(120);
  expect(u?.name).toBe("x");
});

test("updateGroup returns null for an unknown id", async () => {
  expect(await repo.updateGroup("missing", { name: "z" }, actor)).toBeNull();
});

test("deleteGroup removes the group and returns true", async () => {
  const g = await repo.createGroup({ projectId, name: "x" }, actor);
  expect(await repo.deleteGroup(g.id, actor)).toBe(true);
  expect(await repo.getGroup(g.id)).toBeNull();
});

// ---- audit ----

test("createGroup writes a create audit row under the check_group entity", async () => {
  const g = await repo.createGroup({ projectId, name: "prod" }, actor);
  const row = (await repo.listAudit()).find(
    (e) => e.entityType === "check_group" && e.action === "create",
  )!;
  expect(row.entityId).toBe(g.id);
  expect(row.userId).toBe("user-1");
  expect(row.diff.after).toMatchObject({ name: "prod" });
});

// ---- cascade ----

test("deleting a project cascades its groups", async () => {
  const g = await repo.createGroup({ projectId, name: "x" }, actor);
  await repo.deleteProject(projectId, actor);
  expect(await repo.getGroup(g.id)).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/config-repo/src/groups.test.ts`
Expected: FAIL — `repo.createGroup is not a function` (repo has no group methods yet).

- [ ] **Step 3: Add group types to the repo imports + `ConfigRepo` interface**

In `packages/config-repo/src/repo.ts`, add `AlertRouting`, `CheckGroup`, `CheckGroupInput`, `CheckGroupPatch`, `EffectiveHeartbeatCheck` to the type import block (lines 11–29). Then add these methods to the `ConfigRepo` interface, after the `deleteSite` line (line 57):

```ts
  listGroups(projectId: string): Promise<CheckGroup[]>;
  getGroup(id: string): Promise<CheckGroup | null>;
  createGroup(input: CheckGroupInput, actor: Actor): Promise<CheckGroup>;
  updateGroup(id: string, patch: CheckGroupPatch, actor: Actor): Promise<CheckGroup | null>;
  deleteGroup(id: string, actor: Actor): Promise<boolean>;
```

And add the effective-check accessors after `getCheck` (line 62):

```ts
  /** A single check with CheckGroup inheritance resolved (never a null interval). */
  getEffectiveCheck(id: string): Promise<EffectiveHeartbeatCheck | null>;
  /** Every check across all sites with inheritance resolved — the scheduler tick's input. */
  listEffectiveChecks(): Promise<EffectiveHeartbeatCheck[]>;
```

- [ ] **Step 4: Add a `GROUP_FIELDS` audit constant + import the resolver**

Near the top of `repo.ts`, add the import (after the `./types.ts` import):

```ts
import { resolveEffectiveCheck } from "./effective.ts";
```

After the `CHECK_FIELDS` constant (line 106), add:

```ts
/** CheckGroup fields captured in audit diffs and snapshots. */
const GROUP_FIELDS = [
  "name",
  "defaultIntervalSeconds",
  "defaultAlertRouting",
  "defaultAlertAfterNFails",
] as const;
```

- [ ] **Step 5: Implement the group methods + effective accessors**

In the object returned by `createConfigRepo`, add the following after the `deleteSite` method (and before `listChecks`):

```ts
    listGroups: (projectId) => store.groups.listByProject(projectId),
    getGroup: (id) => store.groups.get(id),

    async createGroup(input, actor) {
      if (!input.projectId) throw new ValidationError("projectId", "Project is required");
      const fields = normalizeGroupCreate(input);
      const ts = now();
      const group = await store.groups.insert({
        id: genId(),
        projectId: input.projectId,
        ...fields,
        createdAt: ts,
        updatedAt: ts,
      });
      await audit("check_group", group.id, "create", { after: snapshot(group, GROUP_FIELDS) }, actor);
      return group;
    },

    async updateGroup(id, patch, actor) {
      const before = await store.groups.get(id);
      if (!before) return null;
      const normalized = normalizeGroupPatch(patch);
      const updated = await store.groups.update(id, normalized);
      if (!updated) return null;
      const diff = diffFields(before, updated, Object.keys(normalized));
      if (diff) await audit("check_group", id, "update", diff, actor);
      return updated;
    },

    async deleteGroup(id, actor) {
      const removed = await store.groups.remove(id);
      if (!removed) return false;
      await audit("check_group", id, "delete", { before: snapshot(removed, GROUP_FIELDS) }, actor);
      return true;
    },
```

And add the effective accessors immediately after the existing `getCheck` line (`getCheck: (id) => store.checks.get(id),`):

```ts
    async getEffectiveCheck(id) {
      const check = await store.checks.get(id);
      if (!check) return null;
      const group = check.groupId ? await store.groups.get(check.groupId) : null;
      return resolveEffectiveCheck(check, group);
    },

    async listEffectiveChecks() {
      const checks = await store.checks.listAll();
      const groupCache = new Map<string, CheckGroup | null>();
      const effective: EffectiveHeartbeatCheck[] = [];
      for (const check of checks) {
        let group: CheckGroup | null = null;
        if (check.groupId) {
          if (!groupCache.has(check.groupId)) {
            groupCache.set(check.groupId, await store.groups.get(check.groupId));
          }
          group = groupCache.get(check.groupId) ?? null;
        }
        effective.push(resolveEffectiveCheck(check, group));
      }
      return effective;
    },
```

- [ ] **Step 6: Add the group normalization helpers**

After the `normalizeBaseUrl` function (around line 326), add:

```ts
// ---- CheckGroup validation / normalization ----

/** Validated, defaulted CheckGroup fields ready to persist (no id/projectId/timestamps). */
type GroupFields = Omit<CheckGroup, "id" | "projectId" | "createdAt" | "updatedAt">;

function normalizeGroupCreate(input: CheckGroupInput): GroupFields {
  return {
    name: validateName(input.name),
    defaultIntervalSeconds: normalizeNullablePositiveInt(
      "defaultIntervalSeconds",
      input.defaultIntervalSeconds,
    ),
    defaultAlertAfterNFails: normalizeNullablePositiveInt(
      "defaultAlertAfterNFails",
      input.defaultAlertAfterNFails,
    ),
    defaultAlertRouting: normalizeAlertRouting(input.defaultAlertRouting),
  };
}

function normalizeGroupPatch(patch: CheckGroupPatch): CheckGroupPatch {
  const out: CheckGroupPatch = {};
  if (patch.name !== undefined) out.name = validateName(patch.name);
  if (patch.defaultIntervalSeconds !== undefined) {
    out.defaultIntervalSeconds = normalizeNullablePositiveInt(
      "defaultIntervalSeconds",
      patch.defaultIntervalSeconds,
    );
  }
  if (patch.defaultAlertAfterNFails !== undefined) {
    out.defaultAlertAfterNFails = normalizeNullablePositiveInt(
      "defaultAlertAfterNFails",
      patch.defaultAlertAfterNFails,
    );
  }
  if (patch.defaultAlertRouting !== undefined) {
    out.defaultAlertRouting = normalizeAlertRouting(patch.defaultAlertRouting);
  }
  return out;
}

/** Validate routing the same way Project routing is validated; null clears it. */
function normalizeAlertRouting(value: AlertRouting | null | undefined): AlertRouting | null {
  if (value == null) return null;
  return {
    slackChannel: normalizeSlack(value.slackChannel),
    alertEmails: validateEmails(value.alertEmails ?? []),
  };
}
```

- [ ] **Step 7: Add the nullable-int helper (shared by checks + groups)**

After `validatePositiveInt` (around line 380), add:

```ts
/** Like validatePositiveInt, but null/undefined is allowed (means "inherit"). */
function normalizeNullablePositiveInt(field: string, value: number | null | undefined): number | null {
  if (value == null) return null;
  return validatePositiveInt(field, value);
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `bun test packages/config-repo/src/groups.test.ts`
Expected: PASS (all group tests).

- [ ] **Step 9: Commit**

```bash
git add packages/config-repo/src/repo.ts packages/config-repo/src/groups.test.ts
git commit -m "feat(config-repo): CheckGroup CRUD + audit + effective-check accessors (#08)"
```

---

## Task 4: Repo — nullable check fields + groupId integrity + effective-check tests

**Files:**
- Modify: `packages/config-repo/src/repo.ts`
- Test: `packages/config-repo/src/checks.test.ts`

- [ ] **Step 1: Update the now-wrong defaults test + add inheritance tests**

In `packages/config-repo/src/checks.test.ts`, **replace** the test `createCheck applies sensible defaults` (lines 32–40) with:

```ts
test("createCheck stores nulls for omitted interval/alertAfterNFails (inherit)", async () => {
  const c = await repo.createCheck({ siteId }, actor);
  expect(c.path).toBe("/");
  expect(c.certCheck).toBe(false);
  expect(c.dnsCheck).toBe(false);
  expect(c.bodyAssertion).toBeNull();
  expect(c.groupId).toBeNull();
  expect(c.intervalSeconds).toBeNull(); // null = inherit
  expect(c.alertAfterNFails).toBeNull();
});

test("getEffectiveCheck resolves an ungrouped check to system defaults", async () => {
  const c = await repo.createCheck({ siteId }, actor);
  const e = await repo.getEffectiveCheck(c.id);
  expect(e?.intervalSeconds).toBe(300);
  expect(e?.alertAfterNFails).toBe(1);
  expect(e?.alertRouting).toBeNull();
});

test("getEffectiveCheck inherits the group's interval when the check leaves it null", async () => {
  const projectId = (await repo.getSite(siteId))!.projectId;
  const group = await repo.createGroup({ projectId, name: "prod", defaultIntervalSeconds: 600 }, actor);
  const c = await repo.createCheck({ siteId, groupId: group.id }, actor);
  const e = await repo.getEffectiveCheck(c.id);
  expect(e?.intervalSeconds).toBe(600);
});

test("a per-check interval overrides the group default", async () => {
  const projectId = (await repo.getSite(siteId))!.projectId;
  const group = await repo.createGroup({ projectId, name: "prod", defaultIntervalSeconds: 600 }, actor);
  const c = await repo.createCheck({ siteId, groupId: group.id, intervalSeconds: 60 }, actor);
  const e = await repo.getEffectiveCheck(c.id);
  expect(e?.intervalSeconds).toBe(60);
});

test("createCheck rejects a groupId from a different project", async () => {
  const other = await repo.createProject({ name: "Globex" }, actor);
  const otherGroup = await repo.createGroup({ projectId: other.id, name: "x" }, actor);
  const err = await repo.createCheck({ siteId, groupId: otherGroup.id }, actor).catch((e) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).field).toBe("groupId");
});

test("listEffectiveChecks resolves inheritance across sites", async () => {
  const projectId = (await repo.getSite(siteId))!.projectId;
  const group = await repo.createGroup({ projectId, name: "prod", defaultIntervalSeconds: 600 }, actor);
  await repo.createCheck({ siteId, groupId: group.id }, actor);
  const all = await repo.listEffectiveChecks();
  expect(all.every((c) => typeof c.intervalSeconds === "number")).toBe(true);
  expect(all.find((c) => c.groupId === group.id)?.intervalSeconds).toBe(600);
});
```

(The audit-create test `createCheck writes a create audit row…` still passes — its `diff.after` now also carries `groupId`, but `toMatchObject({ path: "/health" })` is unaffected. No change needed.)

- [ ] **Step 2: Run the test to verify the new ones fail**

Run: `bun test packages/config-repo/src/checks.test.ts`
Expected: FAIL — `createCheck` still defaults interval to 300 (so `intervalSeconds` is not null) and there is no cross-project `groupId` rejection yet.

- [ ] **Step 3: Update `CHECK_FIELDS` to include `groupId`**

In `repo.ts`, update `CHECK_FIELDS` (lines 99–106) to add `"groupId"` first:

```ts
const CHECK_FIELDS = [
  "groupId",
  "path",
  "bodyAssertion",
  "certCheck",
  "dnsCheck",
  "intervalSeconds",
  "alertAfterNFails",
] as const;
```

- [ ] **Step 4: Remove the obsolete check defaults + rewrite `normalizeCheckCreate`/`normalizeCheckPatch`**

Delete the now-unused constants `DEFAULT_INTERVAL_SECONDS` and `DEFAULT_ALERT_AFTER_N_FAILS` (lines 84–85). Keep `DEFAULT_RETENTION_DAYS`.

Replace `normalizeCheckCreate` (lines 333–349) with (cross-project `groupId` validation happens in `createCheck`, Step 5 — the normalize fn is pure):

```ts
function normalizeCheckCreate(input: HeartbeatCheckInput): CheckFields {
  if (!input.siteId) throw new ValidationError("siteId", "Site is required");
  return {
    groupId: input.groupId ?? null,
    path: normalizePath(input.path),
    bodyAssertion: normalizeBodyAssertion(input.bodyAssertion),
    certCheck: input.certCheck ?? false,
    dnsCheck: input.dnsCheck ?? false,
    intervalSeconds: normalizeNullablePositiveInt("intervalSeconds", input.intervalSeconds),
    alertAfterNFails: normalizeNullablePositiveInt("alertAfterNFails", input.alertAfterNFails),
  };
}
```

Replace `normalizeCheckPatch` (lines 351–364) with:

```ts
function normalizeCheckPatch(patch: HeartbeatCheckPatch): HeartbeatCheckPatch {
  const out: HeartbeatCheckPatch = {};
  if (patch.groupId !== undefined) out.groupId = patch.groupId;
  if (patch.path !== undefined) out.path = normalizePath(patch.path);
  if (patch.bodyAssertion !== undefined) out.bodyAssertion = normalizeBodyAssertion(patch.bodyAssertion);
  if (patch.certCheck !== undefined) out.certCheck = patch.certCheck;
  if (patch.dnsCheck !== undefined) out.dnsCheck = patch.dnsCheck;
  if (patch.intervalSeconds !== undefined) {
    out.intervalSeconds = normalizeNullablePositiveInt("intervalSeconds", patch.intervalSeconds);
  }
  if (patch.alertAfterNFails !== undefined) {
    out.alertAfterNFails = normalizeNullablePositiveInt("alertAfterNFails", patch.alertAfterNFails);
  }
  return out;
}
```

- [ ] **Step 5: Add cross-project `groupId` validation to `createCheck`/`updateCheck`**

Add a private helper inside `createConfigRepo` (next to the `audit` helper):

```ts
  /** Ensure a check's groupId (when set) names a group owned by the site's project. */
  async function assertGroupMatchesSite(groupId: string | null, siteId: string): Promise<void> {
    if (groupId == null) return;
    const [group, site] = await Promise.all([store.groups.get(groupId), store.sites.get(siteId)]);
    if (!group || !site || group.projectId !== site.projectId) {
      throw new ValidationError("groupId", "Group must belong to the check's project");
    }
  }
```

In `createCheck`, immediately after `const fields = normalizeCheckCreate(input);` add:

```ts
      await assertGroupMatchesSite(fields.groupId, input.siteId);
```

In `updateCheck`, immediately after `const normalized = normalizeCheckPatch(patch);` add (the parent site is fixed on the existing check `before`):

```ts
      if (normalized.groupId !== undefined) {
        await assertGroupMatchesSite(normalized.groupId, before.siteId);
      }
```

- [ ] **Step 6: Run the full config-repo test suite**

Run: `bun test packages/config-repo`
Expected: PASS — all of `effective.test.ts`, `groups.test.ts`, `checks.test.ts`, `repo.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/config-repo/src/repo.ts packages/config-repo/src/checks.test.ts
git commit -m "feat(config-repo): null-means-inherit check fields + groupId integrity (#08)"
```

---

## Task 5: Postgres store — groups + nullable check columns

**Files:**
- Modify: `packages/config-repo/src/pg-store.ts`

(No unit test — the pg-store mirrors the in-memory store and is covered by `scripts/smoke.ts` against real Postgres. Gate: `bun test` stays green + it type-checks; run `bun run smoke` against a DB if one is available.)

- [ ] **Step 1: Import the group types + add the `CheckGroupRow` interface**

Extend the type import block to add `AlertRouting`, `CheckGroup`, `CheckGroupPatch`. After the `CheckRow` interface, add:

```ts
interface CheckGroupRow {
  id: string;
  project_id: string;
  name: string;
  default_interval_seconds: number | null;
  default_alert_routing: AlertRouting | null;
  default_alert_after_n_fails: number | null;
  created_at: Date;
  updated_at: Date;
}
```

- [ ] **Step 2: Update `CheckRow` + `toCheck` for the new nullable columns + group_id**

Change `CheckRow` so `interval_seconds`/`alert_after_n_fails` are nullable and add `group_id`:

```ts
interface CheckRow {
  id: string;
  site_id: string;
  group_id: string | null;
  path: string;
  body_assertion: BodyAssertion | null;
  cert_check: boolean;
  dns_check: boolean;
  interval_seconds: number | null;
  alert_after_n_fails: number | null;
  created_at: Date;
  updated_at: Date;
}
```

Update `toCheck` to map them:

```ts
function toCheck(r: CheckRow): HeartbeatCheck {
  return {
    id: r.id,
    siteId: r.site_id,
    groupId: r.group_id,
    path: r.path,
    bodyAssertion: r.body_assertion,
    certCheck: r.cert_check,
    dnsCheck: r.dns_check,
    intervalSeconds: r.interval_seconds,
    alertAfterNFails: r.alert_after_n_fails,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
```

Add a `toGroup` mapper next to `toCheck`:

```ts
function toGroup(r: CheckGroupRow): CheckGroup {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    defaultIntervalSeconds: r.default_interval_seconds,
    defaultAlertRouting: r.default_alert_routing,
    defaultAlertAfterNFails: r.default_alert_after_n_fails,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
```

- [ ] **Step 3: Update the `checks.insert`/`update` SQL for group_id + nullable columns**

Replace `checks.insert` so `group_id` is in the column list and values (after `site_id`):

```ts
      async insert(check) {
        const sql = getSql();
        const rows = await sql<CheckRow[]>`
          insert into heartbeat_checks
            (id, site_id, group_id, path, body_assertion, cert_check, dns_check,
             interval_seconds, alert_after_n_fails, created_at, updated_at)
          values
            (${check.id}, ${check.siteId}, ${check.groupId}, ${check.path},
             ${check.bodyAssertion ? sql.json(check.bodyAssertion as unknown as Parameters<typeof sql.json>[0]) : null},
             ${check.certCheck}, ${check.dnsCheck}, ${check.intervalSeconds},
             ${check.alertAfterNFails}, ${check.createdAt}, ${check.updatedAt})
          returning *`;
        return toCheck(rows[0]!);
      },
```

In `checkPatchRow` (bottom of file), add the `group_id` mapping at the top of the function body (before `path`):

```ts
  if (patch.groupId !== undefined) row.group_id = patch.groupId;
```

(The existing `interval_seconds`/`alert_after_n_fails` assignments are unchanged — they may now write `null`.)

- [ ] **Step 4: Add the `groups` sub-store to the returned object**

Add after the `sites` block (before `checks`):

```ts
    groups: {
      async listByProject(projectId) {
        const sql = getSql();
        const rows = await sql<CheckGroupRow[]>`
          select * from check_groups where project_id = ${projectId} order by created_at`;
        return rows.map(toGroup);
      },

      async get(id) {
        const sql = getSql();
        const rows = await sql<CheckGroupRow[]>`select * from check_groups where id = ${id} limit 1`;
        return rows[0] ? toGroup(rows[0]) : null;
      },

      async insert(group) {
        const sql = getSql();
        const rows = await sql<CheckGroupRow[]>`
          insert into check_groups
            (id, project_id, name, default_interval_seconds, default_alert_routing,
             default_alert_after_n_fails, created_at, updated_at)
          values
            (${group.id}, ${group.projectId}, ${group.name}, ${group.defaultIntervalSeconds},
             ${group.defaultAlertRouting ? sql.json(group.defaultAlertRouting as unknown as Parameters<typeof sql.json>[0]) : null},
             ${group.defaultAlertAfterNFails}, ${group.createdAt}, ${group.updatedAt})
          returning *`;
        return toGroup(rows[0]!);
      },

      async update(id, patch) {
        const sql = getSql();
        const row = groupPatchRow(sql, patch);
        const rows = Object.keys(row).length
          ? await sql<CheckGroupRow[]>`
              update check_groups set ${sql(row)}, updated_at = now() where id = ${id} returning *`
          : await sql<CheckGroupRow[]>`
              update check_groups set updated_at = now() where id = ${id} returning *`;
        return rows[0] ? toGroup(rows[0]) : null;
      },

      async remove(id) {
        const sql = getSql();
        const rows = await sql<CheckGroupRow[]>`delete from check_groups where id = ${id} returning *`;
        return rows[0] ? toGroup(rows[0]) : null;
      },
    },
```

- [ ] **Step 5: Add the `groupPatchRow` helper**

At the bottom of the file (next to `checkPatchRow`):

```ts
/** Maps a `CheckGroupPatch` to snake_case columns for a dynamic `update ... set` write. */
function groupPatchRow(sql: Sql, patch: CheckGroupPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.defaultIntervalSeconds !== undefined) {
    row.default_interval_seconds = patch.defaultIntervalSeconds;
  }
  if (patch.defaultAlertAfterNFails !== undefined) {
    row.default_alert_after_n_fails = patch.defaultAlertAfterNFails;
  }
  if (patch.defaultAlertRouting !== undefined) {
    row.default_alert_routing = patch.defaultAlertRouting
      ? sql.json(patch.defaultAlertRouting as unknown as Parameters<typeof sql.json>[0])
      : null;
  }
  return row;
}
```

- [ ] **Step 6: Verify it type-checks and the suite is green**

Run: `bun test packages/config-repo`
Expected: PASS (pg-store isn't hit by these tests, but the file must compile — a type error here fails the import).

- [ ] **Step 7: Commit**

```bash
git add packages/config-repo/src/pg-store.ts
git commit -m "feat(config-repo): pg store for check_groups + nullable check columns (#08)"
```

---

## Task 6: Export the new public surface (config-repo)

**Files:**
- Modify: `packages/config-repo/src/index.ts`

- [ ] **Step 1: Add the new types + resolver to the public export**

Replace the body of `packages/config-repo/src/index.ts` with:

```ts
/** Public surface of `@naikan/config-repo`. */
export type {
  Actor,
  AlertRouting,
  AuditAction,
  AuditDiff,
  AuditLogEntry,
  BodyAssertion,
  CheckGroup,
  CheckGroupInput,
  CheckGroupPatch,
  CheckRun,
  CheckRunInput,
  CheckRunStatus,
  CheckType,
  Project,
  ProjectInput,
  ProjectPatch,
  ConfigStore,
  EffectiveHeartbeatCheck,
  HeartbeatCheck,
  HeartbeatCheckInput,
  HeartbeatCheckPatch,
  Site,
  SiteInput,
  SitePatch,
} from "./types.ts";
export { createConfigRepo, ValidationError, type ConfigRepo, type ConfigRepoDeps } from "./repo.ts";
export { InMemoryConfigStore } from "./in-memory-store.ts";
export { createPgConfigStore } from "./pg-store.ts";
export {
  resolveEffectiveCheck,
  SYSTEM_DEFAULT_INTERVAL_SECONDS,
  SYSTEM_DEFAULT_ALERT_AFTER_N_FAILS,
} from "./effective.ts";
```

- [ ] **Step 2: Verify the package still resolves**

Run: `bun test packages/config-repo`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/config-repo/src/index.ts
git commit -m "feat(config-repo): export CheckGroup/effective public surface (#08)"
```

---

## Task 7: Migration — check_groups table + nullable check columns

**Files:**
- Create: `migrations/1810000000000_check-groups.js`

- [ ] **Step 1: Write the migration**

Create `migrations/1810000000000_check-groups.js`:

```js
/**
 * CheckGroups + HeartbeatCheck inheritance (issue #08).
 *
 * - `check_groups.project_id` → projects(id) ON DELETE CASCADE: deleting a project
 *   drops its groups (matching sites).
 * - default_* columns are nullable: a null group default means "fall through to
 *   the system default" (effective = check ?? group ?? system).
 * - `default_alert_routing` is nullable jsonb: `{ slackChannel, alertEmails[] }`.
 * - `heartbeat_checks.group_id` → check_groups(id) ON DELETE SET NULL: deleting a
 *   group leaves its checks ungrouped (they fall back to the system default).
 * - `heartbeat_checks.interval_seconds` / `alert_after_n_fails` become nullable
 *   (null = inherit from the group). The positive-value CHECKs are relaxed to
 *   allow null.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable("check_groups", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    project_id: { type: "uuid", notNull: true, references: "projects", onDelete: "CASCADE" },
    name: { type: "text", notNull: true },
    default_interval_seconds: { type: "integer" },
    default_alert_routing: { type: "jsonb" },
    default_alert_after_n_fails: { type: "integer" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint(
    "check_groups",
    "check_groups_interval_positive",
    "CHECK (default_interval_seconds IS NULL OR default_interval_seconds > 0)",
  );
  pgm.addConstraint(
    "check_groups",
    "check_groups_alert_after_positive",
    "CHECK (default_alert_after_n_fails IS NULL OR default_alert_after_n_fails > 0)",
  );
  pgm.createIndex("check_groups", "project_id");

  // heartbeat_checks: add the FK + relax interval/alert columns to nullable (inherit).
  pgm.addColumn("heartbeat_checks", {
    group_id: { type: "uuid", references: "check_groups", onDelete: "SET NULL" },
  });
  pgm.createIndex("heartbeat_checks", "group_id");

  pgm.alterColumn("heartbeat_checks", "interval_seconds", { notNull: false, default: null });
  pgm.alterColumn("heartbeat_checks", "alert_after_n_fails", { notNull: false, default: null });

  pgm.dropConstraint("heartbeat_checks", "heartbeat_checks_interval_positive");
  pgm.dropConstraint("heartbeat_checks", "heartbeat_checks_alert_after_positive");
  pgm.addConstraint(
    "heartbeat_checks",
    "heartbeat_checks_interval_positive",
    "CHECK (interval_seconds IS NULL OR interval_seconds > 0)",
  );
  pgm.addConstraint(
    "heartbeat_checks",
    "heartbeat_checks_alert_after_positive",
    "CHECK (alert_after_n_fails IS NULL OR alert_after_n_fails > 0)",
  );
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropConstraint("heartbeat_checks", "heartbeat_checks_interval_positive");
  pgm.dropConstraint("heartbeat_checks", "heartbeat_checks_alert_after_positive");
  pgm.dropIndex("heartbeat_checks", "group_id");
  pgm.dropColumn("heartbeat_checks", "group_id");
  pgm.alterColumn("heartbeat_checks", "interval_seconds", { notNull: true, default: 300 });
  pgm.alterColumn("heartbeat_checks", "alert_after_n_fails", { notNull: true, default: 1 });
  pgm.addConstraint(
    "heartbeat_checks",
    "heartbeat_checks_interval_positive",
    "CHECK (interval_seconds > 0)",
  );
  pgm.addConstraint(
    "heartbeat_checks",
    "heartbeat_checks_alert_after_positive",
    "CHECK (alert_after_n_fails > 0)",
  );
  pgm.dropTable("check_groups");
};
```

- [ ] **Step 2: Verify the migration file parses**

Run: `node -e "require('./migrations/1810000000000_check-groups.js'); console.log('ok')"`
Expected: prints `ok` (no syntax error). Full `up`/`down` against Postgres is verified by `bun run migrate` when a DB is available — note this in the issue comment if no DB is reachable in this environment.

- [ ] **Step 3: Commit**

```bash
git add migrations/1810000000000_check-groups.js
git commit -m "feat(db): check_groups table + nullable heartbeat_check inheritance columns (#08)"
```

---

## Task 8: Worker tick consumes effective checks + integration test

**Files:**
- Modify: `apps/worker/src/tick.ts`
- Test: `apps/worker/src/worker.test.ts`

- [ ] **Step 1: Write the failing integration test**

In `apps/worker/src/worker.test.ts`, add at the end of the file (the `controllableClock`, `passingRunner`, `repo`, and `actor` helpers already exist near the top):

```ts
// ---- CheckGroup inheritance (issue #08): the tick schedules on the effective interval ----

test("a check with no interval inherits its group's interval for scheduling", async () => {
  const clock = controllableClock(0);
  const project = await repo.createProject({ name: "Acme" }, actor);
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  const group = await repo.createGroup(
    { projectId: project.id, name: "prod", defaultIntervalSeconds: 300 },
    actor,
  );
  const check = await repo.createCheck({ siteId: site.id, path: "/health", groupId: group.id }, actor);
  const runCheck = passingRunner(clock.now);
  const enqueue = async (job: ScheduledJob): Promise<void> => {
    await runHeartbeatJob(job.checkId, { repo, runCheck });
  };

  await runTick({ now: clock.now, repo, enqueue }); // t=0: never run -> due
  clock.advance(120); // < 300s inherited interval -> not due
  await runTick({ now: clock.now, repo, enqueue });
  expect(await repo.listRuns(check.id)).toHaveLength(1);

  clock.advance(180); // now 300s since first run -> due
  await runTick({ now: clock.now, repo, enqueue });
  expect(await repo.listRuns(check.id)).toHaveLength(2);
});

test("a per-check interval override changes the inherited cadence", async () => {
  const clock = controllableClock(0);
  const project = await repo.createProject({ name: "Acme" }, actor);
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  const group = await repo.createGroup(
    { projectId: project.id, name: "prod", defaultIntervalSeconds: 300 },
    actor,
  );
  const check = await repo.createCheck({ siteId: site.id, path: "/health", groupId: group.id }, actor);
  const runCheck = passingRunner(clock.now);
  const enqueue = async (job: ScheduledJob): Promise<void> => {
    await runHeartbeatJob(job.checkId, { repo, runCheck });
  };

  await runTick({ now: clock.now, repo, enqueue }); // t=0 -> due (1 run, inherited 300s)
  await repo.updateCheck(check.id, { intervalSeconds: 60 }, actor); // override to 60s
  clock.advance(60);
  await runTick({ now: clock.now, repo, enqueue }); // 60s elapsed, override -> due
  expect(await repo.listRuns(check.id)).toHaveLength(2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/worker/src/worker.test.ts`
Expected: FAIL — the tick still reads `repo.listAllChecks()`, whose `intervalSeconds` is `null` for an inheriting check. `null` reaches `ScheduleEntry.intervalSeconds`; `isDue` computes `null * 1000 = 0`, so the check is treated as due on *every* tick → the first assertion (`toHaveLength(1)` after a sub-interval tick) fails with 2 runs.

- [ ] **Step 3: Switch the tick to effective checks**

In `apps/worker/src/tick.ts`, change the `listAllChecks` call. Replace lines 31–41 (the `const checks = …` through the `entries` mapping) with:

```ts
  const checks = await repo.listEffectiveChecks();
  const entries: ScheduleEntry[] = await Promise.all(
    checks.map(async (check) => {
      const [latest] = await repo.listRuns(check.id, 1);
      return {
        checkId: check.id,
        intervalSeconds: check.intervalSeconds, // resolved (never null) by config-repo
        lastRunAt: latest?.startedAt ?? null,
      };
    }),
  );
```

Update the file's top doc-comment sentence that says it "gathers every check's interval and last-run time" to note the interval is the *effective* (inheritance-resolved) one:

```ts
 * One tick gathers every check's *effective* interval (CheckGroup inheritance
 * resolved by config-repo) and last-run time, asks the *pure*
 * `@naikan/scheduler` which checks are due, and enqueues a heartbeat-run job
 * for each.
```

- [ ] **Step 4: Run the worker tests to verify they pass**

Run: `bun test apps/worker`
Expected: PASS — both new tests + all existing worker tests (the existing tests use explicit `intervalSeconds`, which resolve to themselves).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/tick.ts apps/worker/src/worker.test.ts
git commit -m "feat(worker): tick schedules on effective (inherited) intervals (#08)"
```

---

## Task 9: API — CheckGroup route module

**Files:**
- Create: `apps/api/src/group/routes.ts`
- Test: `apps/api/src/group/routes.test.ts`

- [ ] **Step 1: Write the failing route test**

Create `apps/api/src/group/routes.test.ts`:

```ts
import { beforeEach, expect, test } from "bun:test";
import { createConfigRepo, InMemoryConfigStore, type ConfigRepo } from "@naikan/config-repo";
import { createGroupApp } from "./routes.ts";
import { createAuth, type Auth } from "../auth/service.ts";
import { InMemorySessionStore, InMemoryUserStore } from "../auth/in-memory-stores.ts";

let app: ReturnType<typeof createGroupApp>;
let auth: Auth;
let repo: ConfigRepo;
let projectId: string;

beforeEach(async () => {
  auth = createAuth({ users: new InMemoryUserStore(), sessions: new InMemorySessionStore() });
  await auth.createUser({ email: "admin@example.com", password: "adminpass", role: "admin" });
  await auth.createUser({ email: "viewer@example.com", password: "viewerpass", role: "viewer" });
  repo = createConfigRepo(new InMemoryConfigStore());
  const project = await repo.createProject({ name: "Acme" }, { id: null });
  projectId = project.id;
  app = createGroupApp({ auth, repo });
});

async function cookieFor(email: string, password: string): Promise<string> {
  const result = await auth.login(email, password);
  return `cm_session=${result!.session.id}`;
}

const JSON_HEADERS = { "content-type": "application/json" };

test("listing groups requires a session (401)", async () => {
  expect((await app.request(`/api/projects/${projectId}/groups`)).status).toBe(401);
});

test("viewer can list groups (200) but cannot create one (403)", async () => {
  const cookie = await cookieFor("viewer@example.com", "viewerpass");
  expect((await app.request(`/api/projects/${projectId}/groups`, { headers: { cookie } })).status).toBe(200);
  const created = await app.request(`/api/projects/${projectId}/groups`, {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ name: "prod" }),
  });
  expect(created.status).toBe(403);
});

test("admin creates, reads, updates, and deletes a group", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const created = await app.request(`/api/projects/${projectId}/groups`, {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ name: "prod", defaultIntervalSeconds: 300 }),
  });
  expect(created.status).toBe(201);
  const { group } = (await created.json()) as { group: { id: string; name: string } };
  expect(group.name).toBe("prod");

  expect((await app.request(`/api/groups/${group.id}`, { headers: { cookie } })).status).toBe(200);

  const patched = await app.request(`/api/groups/${group.id}`, {
    method: "PATCH",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ defaultIntervalSeconds: 600 }),
  });
  expect(patched.status).toBe(200);

  expect((await app.request(`/api/groups/${group.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(204);
  expect((await app.request(`/api/groups/${group.id}`, { headers: { cookie } })).status).toBe(404);
});

test("creating a group under a missing project is 404", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const res = await app.request(`/api/projects/missing/groups`, {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ name: "x" }),
  });
  expect(res.status).toBe(404);
});

test("a validation error maps to 400 with the field name", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const res = await app.request(`/api/projects/${projectId}/groups`, {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ name: "x", defaultIntervalSeconds: 0 }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { field?: string };
  expect(body.field).toBe("defaultIntervalSeconds");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/api/src/group/routes.test.ts`
Expected: FAIL — `Cannot find module './routes.ts'`.

- [ ] **Step 3: Write the route module**

Create `apps/api/src/group/routes.ts` (modeled on `config/routes.ts` — same `withValidation`/`readJson` helpers, same read/write gating):

```ts
/**
 * HTTP surface for CheckGroups (issue #08), mounted under `/api`. Groups are
 * nested under a project for list/create and flat for get/update/delete,
 * mirroring the Site routes. Reads are open to any authenticated user; writes
 * are admin-only. Every mutation passes the acting user to the repo, which
 * records it in the audit log; `ValidationError` maps to 400 with the field.
 */
import { Hono } from "hono";
import { requireAuth, requireRole, type AuthEnv } from "../auth/middleware.ts";
import type { Auth } from "../auth/service.ts";
import {
  ValidationError,
  type Actor,
  type CheckGroupInput,
  type CheckGroupPatch,
  type ConfigRepo,
} from "@naikan/config-repo";

export interface GroupAppOptions {
  auth: Auth;
  repo: ConfigRepo;
}

export function createGroupApp(opts: GroupAppOptions) {
  const { auth, repo } = opts;
  const app = new Hono<AuthEnv>();

  const read = [requireAuth(auth)] as const;
  const write = [requireAuth(auth), requireRole("admin")] as const;
  const actorOf = (c: { get: (k: "user") => { id: string } }): Actor => ({ id: c.get("user").id });

  app.get("/api/projects/:id/groups", ...read, async (c) => {
    const project = await repo.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    return c.json({ groups: await repo.listGroups(project.id) });
  });

  app.post("/api/projects/:id/groups", ...write, async (c) => {
    const project = await repo.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    const body = await readJson(c);
    return withValidation(c, async () => {
      const group = await repo.createGroup(
        { ...body, projectId: project.id } as unknown as CheckGroupInput,
        actorOf(c),
      );
      return c.json({ group }, 201);
    });
  });

  app.get("/api/groups/:id", ...read, async (c) => {
    const group = await repo.getGroup(c.req.param("id"));
    if (!group) return c.json({ error: "group not found" }, 404);
    return c.json({ group });
  });

  app.patch("/api/groups/:id", ...write, async (c) => {
    const body = await readJson(c);
    return withValidation(c, async () => {
      const group = await repo.updateGroup(
        c.req.param("id"),
        body as unknown as CheckGroupPatch,
        actorOf(c),
      );
      if (!group) return c.json({ error: "group not found" }, 404);
      return c.json({ group });
    });
  });

  app.delete("/api/groups/:id", ...write, async (c) => {
    const deleted = await repo.deleteGroup(c.req.param("id"), actorOf(c));
    if (!deleted) return c.json({ error: "group not found" }, 404);
    return c.body(null, 204);
  });

  return app;
}

/** Runs a repo write, mapping `ValidationError` to a 400 carrying the field name. */
async function withValidation(
  c: { json: (body: unknown, status?: 400) => Response },
  run: () => Promise<Response>,
): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: err.message, field: err.field }, 400);
    }
    throw err;
  }
}

/** Parses a JSON body, tolerating an empty/invalid body as `{}`. */
async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/api/src/group/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/group/routes.ts apps/api/src/group/routes.test.ts
git commit -m "feat(api): CheckGroup CRUD routes (#08)"
```

---

## Task 10: API — wire group routes + heartbeat groupId pass-through

**Files:**
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/dev-no-db.ts`
- Test: `apps/api/src/heartbeat/routes.test.ts`

- [ ] **Step 1: Add a heartbeat route test for group assignment + cross-project rejection**

In `apps/api/src/heartbeat/routes.test.ts`, add after the CRUD test (the `createCheck` helper, `cookieFor`, `JSON_HEADERS`, `repo`, and `siteId` already exist):

```ts
test("admin can create a check assigned to a group and clear it back to inherit", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  // The site's project owns the group (the repo enforces same-project membership).
  const project = await repo.createProject({ name: "Grouped" }, { id: null });
  const groupedSite = await repo.createSite({ projectId: project.id, baseUrl: "https://g.test" }, { id: null });
  const group = await repo.createGroup({ projectId: project.id, name: "prod", defaultIntervalSeconds: 600 }, { id: null });

  const created = await app.request(`/api/sites/${groupedSite.id}/checks`, {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ path: "/health", groupId: group.id }),
  });
  expect(created.status).toBe(201);
  const { check } = (await created.json()) as {
    check: { id: string; groupId: string | null; intervalSeconds: number | null };
  };
  expect(check.groupId).toBe(group.id);
  expect(check.intervalSeconds).toBeNull(); // inherits

  const cleared = await app.request(`/api/checks/${check.id}`, {
    method: "PATCH",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ groupId: null, intervalSeconds: 120 }),
  });
  expect(cleared.status).toBe(200);
  const patched = (await cleared.json()) as { check: { groupId: string | null; intervalSeconds: number | null } };
  expect(patched.check.groupId).toBeNull();
  expect(patched.check.intervalSeconds).toBe(120);
});

test("assigning a group from another project is rejected (400 groupId)", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const other = await repo.createProject({ name: "Other" }, { id: null });
  const otherGroup = await repo.createGroup({ projectId: other.id, name: "x" }, { id: null });
  const res = await app.request(`/api/sites/${siteId}/checks`, {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ path: "/health", groupId: otherGroup.id }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { field?: string };
  expect(body.field).toBe("groupId");
});
```

(No change to `heartbeat/routes.ts` is required: it already forwards the raw body to `repo.createCheck`/`updateCheck` as `HeartbeatCheckInput`/`HeartbeatCheckPatch`, which now include `groupId`. The repo does the validation. This test pins that pass-through.)

- [ ] **Step 2: Run the heartbeat route test to verify it passes**

Run: `bun test apps/api/src/heartbeat/routes.test.ts`
Expected: PASS — the new tests pass because the repo + types already handle `groupId`. If `groupId` were dropped anywhere in the path, these fail.

- [ ] **Step 3: Mount the group app in `index.ts`**

In `apps/api/src/index.ts`, add the import next to the other route imports:

```ts
import { createGroupApp } from "./group/routes.ts";
```

And mount it after the heartbeat app (line 39):

```ts
// CheckGroups + inheritance (issue #08). Shares the single config-repo.
app.route("/", createGroupApp({ auth, repo: config }));
```

- [ ] **Step 4: Mount the group app + seed a sample group in `dev-no-db.ts`**

In `apps/api/src/dev-no-db.ts`, add the import:

```ts
import { createGroupApp } from "./group/routes.ts";
```

**Replace** the existing seeded `repo.createCheck({ … intervalSeconds: 300 })` block (lines 51–54) with a sample group + a check that inherits from it (so the no-DB UI demonstrates inheritance):

```ts
const sampleGroup = await repo.createGroup(
  {
    projectId: sample.id,
    name: "prod-critical",
    defaultIntervalSeconds: 300,
    defaultAlertAfterNFails: 2,
    defaultAlertRouting: { slackChannel: "#project-northwind", alertEmails: ["alerts@northwind.test"] },
  },
  { id: admin.id },
);
await repo.createCheck(
  { siteId: sampleSite.id, path: "/", certCheck: true, dnsCheck: true, groupId: sampleGroup.id },
  { id: admin.id },
);
```

Then mount the app next to the others (after the `createHeartbeatApp` line):

```ts
app.route("/", createGroupApp({ auth, repo }));
```

- [ ] **Step 5: Run the full API suite**

Run: `bun test apps/api`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/index.ts apps/api/src/dev-no-db.ts apps/api/src/heartbeat/routes.test.ts
git commit -m "feat(api): mount CheckGroup routes + seed sample group; pin groupId pass-through (#08)"
```

---

## Task 11: Web-admin API project — group types + functions

**Files:**
- Modify: `apps/web-admin/src/lib/api.ts`

- [ ] **Step 1: Update `HeartbeatCheck` + `HeartbeatCheckInput` for `groupId` + nullable fields**

In `apps/web-admin/src/lib/api.ts`, in the "Heartbeat checks" section, replace `HeartbeatCheck` and `HeartbeatCheckInput` with:

```ts
export interface HeartbeatCheck {
  id: string;
  siteId: string;
  groupId: string | null;
  path: string;
  bodyAssertion: BodyAssertion | null;
  certCheck: boolean;
  dnsCheck: boolean;
  intervalSeconds: number | null;
  alertAfterNFails: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Fields a create/edit check form submits. Null interval/alertAfterNFails = inherit from the group. */
export interface HeartbeatCheckInput {
  groupId: string | null;
  path: string;
  bodyAssertion: BodyAssertion | null;
  certCheck: boolean;
  dnsCheck: boolean;
  intervalSeconds: number | null;
  alertAfterNFails: number | null;
}
```

- [ ] **Step 2: Add the CheckGroup section**

At the end of `api.ts`, add:

```ts
// ---- Check groups (issue #08) ----

export interface AlertRouting {
  slackChannel: string | null;
  alertEmails: string[];
}

export interface CheckGroup {
  id: string;
  projectId: string;
  name: string;
  defaultIntervalSeconds: number | null;
  defaultAlertRouting: AlertRouting | null;
  defaultAlertAfterNFails: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Fields a create/edit group form submits. */
export interface CheckGroupInput {
  name: string;
  defaultIntervalSeconds: number | null;
  defaultAlertRouting: AlertRouting | null;
  defaultAlertAfterNFails: number | null;
}

export async function listGroups(projectId: string): Promise<CheckGroup[]> {
  const res = await fetch(`/api/projects/${projectId}/groups`);
  if (!res.ok) throw await errorFrom(res, "Could not load check groups");
  return ((await res.json()) as { groups: CheckGroup[] }).groups;
}

export async function createGroup(projectId: string, input: CheckGroupInput): Promise<CheckGroup> {
  const res = await fetch(`/api/projects/${projectId}/groups`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFrom(res, "Could not create check group");
  return ((await res.json()) as { group: CheckGroup }).group;
}

export async function updateGroup(id: string, patch: Partial<CheckGroupInput>): Promise<CheckGroup> {
  const res = await fetch(`/api/groups/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await errorFrom(res, "Could not save check group");
  return ((await res.json()) as { group: CheckGroup }).group;
}

export async function deleteGroup(id: string): Promise<void> {
  const res = await fetch(`/api/groups/${id}`, { method: "DELETE" });
  if (!res.ok) throw await errorFrom(res, "Could not delete check group");
}
```

- [ ] **Step 3: Type-check the SPA**

Run: `bun run typecheck`
Expected: FAIL — `SiteDetail.svelte` (`buildInput()` returns an object without `groupId`; `intervalSeconds`/`alertAfterNFails` are now `number | null`) reports type errors. That is expected; Tasks 12–13 fix the components. This is a known-intermediate checkpoint — commit `api.ts` now and proceed.

- [ ] **Step 4: Commit**

```bash
git add apps/web-admin/src/lib/api.ts
git commit -m "feat(web-admin): CheckGroup API project + nullable check fields (#08)"
```

---

## Task 12: Web-admin — Check groups CRUD under a project

**Files:**
- Modify: `apps/web-admin/src/ProjectDetail.svelte`

- [ ] **Step 1: Import the type + load groups**

In `ProjectDetail.svelte` `<script>`, add `CheckGroup` to the type import:

```ts
  import type { Project, Site, User, CheckGroup } from "./lib/api.ts";
```

In `load()`, change the `Promise.all` to also load groups (declare `groups` state in Step 2 first, or place this after it):

```ts
      [project, sites, groups] = await Promise.all([
        api.getProject(projectId),
        api.listSites(projectId),
        api.listGroups(projectId),
      ]);
```

- [ ] **Step 2: Add group state + form helpers**

Add next to the site sub-form state:

```ts
  // Check group sub-forms.
  let groups = $state<CheckGroup[]>([]);
  let showAddGroup = $state(false);
  let groupForm = $state(blankGroupForm());
  let groupError = $state<string | null>(null);
  let savingGroup = $state(false);
  let editGroupId = $state<string | null>(null);
  let confirmGroupId = $state<string | null>(null);

  function blankGroupForm() {
    return { name: "", defaultIntervalSeconds: "", defaultAlertAfterNFails: "", slackChannel: "", alertEmails: "" };
  }

  function groupFormFrom(g: CheckGroup) {
    return {
      name: g.name,
      defaultIntervalSeconds: g.defaultIntervalSeconds?.toString() ?? "",
      defaultAlertAfterNFails: g.defaultAlertAfterNFails?.toString() ?? "",
      slackChannel: g.defaultAlertRouting?.slackChannel ?? "",
      alertEmails: g.defaultAlertRouting?.alertEmails.join(", ") ?? "",
    };
  }
```

- [ ] **Step 3: Add the group handlers**

Add to the `<script>` (the `parseEmails` helper already exists in this component):

```ts
  function buildGroupInput(): api.CheckGroupInput {
    const interval = groupForm.defaultIntervalSeconds.trim();
    const after = groupForm.defaultAlertAfterNFails.trim();
    const slack = groupForm.slackChannel.trim();
    const emails = parseEmails(groupForm.alertEmails);
    const routing = slack || emails.length ? { slackChannel: slack || null, alertEmails: emails } : null;
    return {
      name: groupForm.name.trim(),
      defaultIntervalSeconds: interval ? Number(interval) : null,
      defaultAlertAfterNFails: after ? Number(after) : null,
      defaultAlertRouting: routing,
    };
  }

  function startAddGroup() {
    editGroupId = null;
    groupForm = blankGroupForm();
    groupError = null;
    showAddGroup = true;
  }

  function startEditGroup(g: CheckGroup) {
    editGroupId = g.id;
    groupForm = groupFormFrom(g);
    groupError = null;
    showAddGroup = true;
  }

  async function saveGroup(e: SubmitEvent) {
    e.preventDefault();
    if (!project) return;
    groupError = null;
    savingGroup = true;
    try {
      const input = buildGroupInput();
      if (editGroupId) {
        const updated = await api.updateGroup(editGroupId, input);
        groups = groups.map((g) => (g.id === updated.id ? updated : g));
      } else {
        const created = await api.createGroup(project.id, input);
        groups = [...groups, created];
      }
      showAddGroup = false;
      editGroupId = null;
    } catch (err) {
      groupError = err instanceof api.ApiError ? err.message : "Could not save check group";
    } finally {
      savingGroup = false;
    }
  }

  async function removeGroup(id: string) {
    try {
      await api.deleteGroup(id);
      groups = groups.filter((g) => g.id !== id);
      confirmGroupId = null;
    } catch {
      await load();
    }
  }
```

- [ ] **Step 4: Add the "Check groups" section markup**

In the template, add this `<section>` immediately **before** the existing Sites `<section>` (groups appear above sites). It mirrors the Sites section's classes:

```svelte
  <section class="section">
    <div class="section-head">
      <h2>Check groups</h2>
      <span class="n">{groups.length}</span>
      <div class="spacer"></div>
      {#if session.isAdmin && !showAddGroup}
        <button class="btn btn-ghost" onclick={startAddGroup}>Add group</button>
      {/if}
    </div>

    {#if showAddGroup}
      <form class="createform" onsubmit={saveGroup}>
        <div class="field">
          <label for="gn">Name</label>
          <input id="gn" class="input" autocomplete="off" bind:value={groupForm.name} required />
        </div>
        <div class="field">
          <label for="gi">Default interval (seconds)</label>
          <input id="gi" class="input" type="number" min="1" placeholder="system 300" bind:value={groupForm.defaultIntervalSeconds} />
        </div>
        <div class="field">
          <label for="ga">Default alert after N fails</label>
          <input id="ga" class="input" type="number" min="1" placeholder="system 1" bind:value={groupForm.defaultAlertAfterNFails} />
        </div>
        <div class="field">
          <label for="gs">Alert Slack channel</label>
          <input id="gs" class="input" placeholder="#prod-critical" bind:value={groupForm.slackChannel} />
        </div>
        <div class="field full">
          <label for="ge">Alert emails</label>
          <input id="ge" class="input" placeholder="comma-separated" bind:value={groupForm.alertEmails} />
        </div>
        {#if groupError}
          <p class="formerror full" role="alert">{groupError}</p>
        {/if}
        <div class="actions">
          <div class="spacer"></div>
          <button class="btn btn-ghost" type="button" onclick={() => { showAddGroup = false; editGroupId = null; }} disabled={savingGroup}>Cancel</button>
          <button class="btn btn-primary" type="submit" disabled={savingGroup}>
            {savingGroup ? "Saving…" : editGroupId ? "Save group" : "Create group"}
          </button>
        </div>
      </form>
    {/if}

    {#if groups.length === 0}
      <p class="empty">No check groups yet.{#if session.isAdmin} Define a shared policy (interval, alert routing) checks can inherit.{/if}</p>
    {:else}
      <ul class="rowlist">
        {#each groups as group (group.id)}
          <li>
            <div class="datarow">
              <div class="dr-name">
                <span class="nm">{group.name}</span>
                <span class="sub">
                  every {group.defaultIntervalSeconds ?? 300}s · alert after {group.defaultAlertAfterNFails ?? 1}
                  {#if group.defaultAlertRouting?.slackChannel} · {group.defaultAlertRouting.slackChannel}{/if}
                </span>
              </div>
              {#if session.isAdmin}
                {#if confirmGroupId === group.id}
                  <span class="confirm">
                    Remove? Checks in it fall back to defaults.
                    <button class="btn btn-danger" onclick={() => removeGroup(group.id)}>Yes</button>
                    <button class="btn btn-ghost" onclick={() => (confirmGroupId = null)}>No</button>
                  </span>
                {:else}
                  <div class="dr-actions">
                    <button class="btn btn-ghost" onclick={() => startEditGroup(group)}>Edit</button>
                    <button class="btn btn-danger" onclick={() => (confirmGroupId = group.id)}>Remove</button>
                  </div>
                {/if}
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
```

- [ ] **Step 5: Type-check**

Run: `bun run typecheck`
Expected: no errors *in `ProjectDetail.svelte`* (`SiteDetail.svelte` may still error until Task 13). Confirm no `ProjectDetail`-attributed errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web-admin/src/ProjectDetail.svelte
git commit -m "feat(web-admin): CheckGroup CRUD under a project (#08)"
```

---

## Task 13: Web-admin — group picker + inherit/override on the check form

**Files:**
- Modify: `apps/web-admin/src/SiteDetail.svelte`

- [ ] **Step 1: Import the type + load the project's groups**

In `SiteDetail.svelte` `<script>`, add `CheckGroup` to the type import:

```ts
  import type { CheckRun, HeartbeatCheck, Site, CheckGroup } from "./lib/api.ts";
```

Add state next to `checks`:

```ts
  let groups = $state<CheckGroup[]>([]);
```

In `load()`, after `site = await api.getSite(siteId);`, load the project's groups:

```ts
      groups = await api.listGroups(site.projectId);
```

- [ ] **Step 2: Update the form model for nullable interval + groupId**

Replace `blankForm()` and `formFrom()`:

```ts
  function blankForm() {
    return {
      groupId: "",
      path: "/",
      assertionKind: "" as "" | "regex" | "jsonpath",
      assertionPattern: "",
      assertionEquals: "",
      certCheck: false,
      dnsCheck: false,
      intervalSeconds: "",
      alertAfterNFails: "",
    };
  }

  function formFrom(c: HeartbeatCheck) {
    return {
      groupId: c.groupId ?? "",
      path: c.path,
      assertionKind: (c.bodyAssertion?.kind ?? "") as "" | "regex" | "jsonpath",
      assertionPattern: c.bodyAssertion?.pattern ?? "",
      assertionEquals: c.bodyAssertion?.equals ?? "",
      certCheck: c.certCheck,
      dnsCheck: c.dnsCheck,
      intervalSeconds: c.intervalSeconds?.toString() ?? "",
      alertAfterNFails: c.alertAfterNFails?.toString() ?? "",
    };
  }
```

- [ ] **Step 3: Update `buildInput()` + add inheritance display helpers**

Replace `buildInput()`:

```ts
  function buildInput(): api.HeartbeatCheckInput {
    const kind = form.assertionKind;
    const bodyAssertion = kind
      ? {
          kind,
          pattern: form.assertionPattern.trim(),
          ...(kind === "jsonpath" && form.assertionEquals.trim()
            ? { equals: form.assertionEquals.trim() }
            : {}),
        }
      : null;
    const interval = form.intervalSeconds.trim();
    const after = form.alertAfterNFails.trim();
    return {
      groupId: form.groupId || null,
      path: form.path.trim() || "/",
      bodyAssertion,
      certCheck: form.certCheck,
      dnsCheck: form.dnsCheck,
      intervalSeconds: interval ? Number(interval) : null,
      alertAfterNFails: after ? Number(after) : null,
    };
  }
```

Add the display helpers (the canonical resolution rule lives in `config-repo`; this is a cosmetic mirror — keep `SYS_*` in sync with `SYSTEM_DEFAULT_*`):

```ts
  // System defaults mirror @naikan/config-repo's effective resolver (display only).
  const SYS_INTERVAL = 300;
  const SYS_ALERT_AFTER = 1;

  function selectedGroup(): CheckGroup | null {
    return groups.find((g) => g.id === form.groupId) ?? null;
  }

  // What an empty field will inherit, given the currently-selected group.
  let inheritedInterval = $derived(selectedGroup()?.defaultIntervalSeconds ?? SYS_INTERVAL);
  let inheritedAlertAfter = $derived(selectedGroup()?.defaultAlertAfterNFails ?? SYS_ALERT_AFTER);

  function effectiveInterval(c: HeartbeatCheck): number {
    if (c.intervalSeconds != null) return c.intervalSeconds;
    const g = groups.find((x) => x.id === c.groupId);
    return g?.defaultIntervalSeconds ?? SYS_INTERVAL;
  }
  function effectiveAlertAfter(c: HeartbeatCheck): number {
    if (c.alertAfterNFails != null) return c.alertAfterNFails;
    const g = groups.find((x) => x.id === c.groupId);
    return g?.defaultAlertAfterNFails ?? SYS_ALERT_AFTER;
  }
  function groupName(c: HeartbeatCheck): string | null {
    return groups.find((g) => g.id === c.groupId)?.name ?? null;
  }
```

- [ ] **Step 4: Add the group `<select>` + inherit hints to the form markup**

Add a group field as the first field in the form (before the Path field):

```svelte
      <div class="field">
        <label for="cg">Check group</label>
        <select id="cg" class="select" bind:value={form.groupId}>
          <option value="">No group</option>
          {#each groups as g (g.id)}
            <option value={g.id}>{g.name}</option>
          {/each}
        </select>
      </div>
```

Replace the existing Interval field with:

```svelte
      <div class="field">
        <label for="ci">Interval (seconds)</label>
        <input id="ci" class="input" type="number" min="1" placeholder={`inherit · ${inheritedInterval}s`} bind:value={form.intervalSeconds} />
        <span class="sub">{form.intervalSeconds.trim() ? "Overrides the group/default" : `Inherits ${inheritedInterval}s`}</span>
      </div>
```

Replace the existing Alert-after field with:

```svelte
      <div class="field">
        <label for="ca">Alert after N fails</label>
        <input id="ca" class="input" type="number" min="1" placeholder={`inherit · ${inheritedAlertAfter}`} bind:value={form.alertAfterNFails} />
        <span class="sub">{form.alertAfterNFails.trim() ? "Overrides the group/default" : `Inherits ${inheritedAlertAfter}`}</span>
      </div>
```

(`.sub` is an existing muted text class used elsewhere in this component; reusing it avoids new CSS. If it renders poorly inside `.field`, add `.field .sub { margin-top: 4px; }` to `app.css`.)

- [ ] **Step 5: Show effective interval + group in the check list**

In the check-list row, replace the `every {check.intervalSeconds}s · alert after {check.alertAfterNFails}` line inside `<span class="sub">` with:

```svelte
                <span class="sub">
                  {#each signalTags(check) as t}<span class="tag">{t}</span>{/each}
                  {#if groupName(check)}<span class="tag">{groupName(check)}</span>{/if}
                  every {effectiveInterval(check)}s · alert after {effectiveAlertAfter(check)}
                  {#if check.intervalSeconds == null} · inherited{/if}
                </span>
```

- [ ] **Step 6: Type-check the whole SPA**

Run: `bun run typecheck`
Expected: PASS — no Svelte/TS errors across `ProjectDetail.svelte` and `SiteDetail.svelte`.

- [ ] **Step 7: Manual verification (no-DB dev server)**

Run: `bun run dev:no-db`, open the printed URL, log in as `admin@example.com` / `admin1234`.
Verify the issue's end-to-end demo:
1. Open project "Northwind Coffee" → see the seeded "prod-critical" group (every 300s).
2. Open its site → the seeded check shows the `prod-critical` tag and "every 300s · alert after 2 · inherited".
3. Edit the check → set Interval to `60` → save → row shows "every 60s" (no "inherited").
4. Edit again → clear the interval → row shows "every 300s · inherited".
Stop the server when done.

- [ ] **Step 8: Commit**

```bash
git add apps/web-admin/src/SiteDetail.svelte
git commit -m "feat(web-admin): check group picker + inherit/override on the check form (#08)"
```

---

## Task 14: Full verification + close the issue

**Files:**
- Modify: `docs/mvp/issues/08-checkgroup-inheritance.md`

- [ ] **Step 1: Run the entire test suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: ALL PASS. If a DB is reachable, also run `bun run migrate` then `bun run smoke` and confirm green; if not, note in the issue comment that migration/pg-store were verified by type-check + suite only and need a DB run before deploy.

- [ ] **Step 2: Tick the acceptance criteria + set status**

In `docs/mvp/issues/08-checkgroup-inheritance.md`: change `Status: ready-for-agent` → `Status: ready-for-human`, tick all six `- [ ]` boxes to `- [x]`, and append a `## Comments` section summarizing: the `null`-means-inherit model; the `alert_routing` decision (mirrors Project, stored-only until #10); the scheduler-path change (tick → `listEffectiveChecks`); and any DB-verification caveat.

- [ ] **Step 3: Commit**

```bash
git add docs/mvp/issues/08-checkgroup-inheritance.md
git commit -m "docs(issue): mark #08 complete — ready-for-human, criteria ticked"
```

---

## Self-review

**1. Spec coverage** (issue acceptance criteria → task):
- `CheckGroup` migration + `HeartbeatCheck.group_id` FK (nullable) → **Task 7**.
- Admin UI: CheckGroup CRUD under a project → **Task 12**; check-edit form picks a group + shows inherit vs override → **Task 13**.
- `config-repo.getEffectiveCheck(id)` resolves inheritance → **Task 3** (impl) + **Task 4** (tests).
- `scheduler` consumes effective configs only → **Task 8** (tick → `listEffectiveChecks`; scheduler package unchanged — justified in Design decision #4).
- Unit tests on inheritance (no group / all defaults / partial / full override) → **Task 1** (`effective.test.ts`) + **Task 4** (repo-level).
- Integration test: schedule fires inherited interval, then changes after override → **Task 8** (`worker.test.ts`).
- "What to build" `alert_routing` field → **Tasks 1/3/5/7/12** (stored, CRUD, surfaced; decision #3).

**2. Placeholder scan:** No "TBD"/"add validation"/"similar to" placeholders — every code step shows full content. The one cosmetic duplication (UI `SYS_INTERVAL`/`SYS_ALERT_AFTER`) is called out explicitly with the canonical source noted.

**3. Type consistency:** Method names are consistent across tasks — `resolveEffectiveCheck`, `getEffectiveCheck`, `listEffectiveChecks`, `createGroup`/`updateGroup`/`deleteGroup`/`listGroups`/`getGroup`, `assertGroupMatchesSite`, `normalizeNullablePositiveInt`, `normalizeAlertRouting`. Field names match the entity (`defaultIntervalSeconds`, `defaultAlertRouting`, `defaultAlertAfterNFails`, `groupId`, `intervalSeconds`, `alertAfterNFails`, `alertRouting`). `EffectiveHeartbeatCheck` (produced by the resolver in Task 1) is consumed by the tick (Task 8) and the repo accessors (Task 3) with the same shape. `ConfigStore.groups` (Task 1) is implemented by both stores (Tasks 2, 5) and used by the repo (Task 3).

**Blocked-by:** #07 (scheduler + queue) — complete (recent commits). Unblocked.
