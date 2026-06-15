# incident-machine + persisted incidents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pure `@naikan/incident-machine` state machine (open after N consecutive heartbeat fails, close after 2 consecutive successes, emit `opened` / `still-open` / `closed-recovered(duration)`), persist `Incident` rows, and wire a thin orchestrator that runs after every CheckRun write to apply the resulting transition — surfaced as open + closed incidents on the per-project overview. Alerting is **out of scope** (incidents transition silently; email/Slack lands in #10).

**Architecture:** A new runtime-agnostic package `packages/incident-machine` (mirrors `@naikan/scheduler`) holds the pure decision: `evaluateIncident({ runs, open, alertAfterNFails }) → Transition` plus a `replayIncidents(history, N)` fold for table-driven tests. `config-repo` gains an `Incident` domain type, an `incidents` sub-store (in-memory + Postgres), CRUD-ish repo methods (`getOpenIncident` / `openIncident` / `closeIncident` / `listProjectIncidents`), and a thin orchestrator `applyIncidentForRun({ repo, checkId })` that reads the effective check (for the inherited `alertAfterNFails`, #08), the recent run tail, and the open incident, runs the machine, and writes the transition. The orchestrator is called right after `repo.recordRun(...)` in **both** the worker job (`apps/worker/src/job.ts`) and the API "Run now" route (`apps/api/src/heartbeat/routes.ts`). A new read-only API route exposes a project's incidents; the Svelte admin surfaces open incidents (count + oldest opened_at) and recovered ones (computed duration) on `ProjectDetail.svelte`.

**Tech Stack:** TypeScript (strip-only–safe — no `enum`, no constructor parameter properties; ADR-0001/0005), Bun test runner (`bun test`), `postgres` raw SQL + `node-pg-migrate` (DB), Hono (API), Svelte 5 runes (web-admin). The kernel packages (`packages/*`) stay runtime-agnostic (imported by the Node worker).

---

## Design decisions & assumptions

1. **`M` (successes-to-close) is hard-coded `2`** per the issue, named `SUCCESSES_TO_CLOSE` in the machine. `N` (fails-to-open) is the check's **effective** `alertAfterNFails` (CheckGroup inheritance resolved by `config-repo.getEffectiveCheck`, #08) — never the raw nullable column.

2. **The machine is a single-step decision, the orchestrator drives it after every run.** `evaluateIncident(input)` returns exactly one `Transition` for "the latest run was just recorded." The orchestrator runs after *every* `recordRun`, so an incident opens at exactly the Nth consecutive fail and closes at exactly the 2nd consecutive success. A `replayIncidents(history, N)` helper folds the single-step machine over a growing history (threading the open state) and returns the full `Transition[]` — this is the table-driven test surface the PRD asks for ("(run history, thresholds) → expected transitions").

3. **Timestamps.** The machine reasons over a minimal `RunPoint { status, startedAt }` projection of `CheckRun` (anchoring on `startedAt`, like the scheduler). `opened_at` = `startedAt` of the **first run of the trailing failing streak** (within the window). `closed_at` = `startedAt` of the **latest run** (the 2nd consecutive success that confirmed recovery). `durationMs = closed_at − opened_at` (downtime from first failure to confirmed recovery). The orchestrator fetches a run tail of length `max(N, 2)`, which is exactly enough to detect both open (N trailing fails) and close (2 trailing passes) in normal operation.

4. **`Incident.runIds` (the PRD `runs[]`).** The `incidents` table carries `run_ids uuid[]` to match the PRD data model (`Incident(id, check_id, opened_at, closed_at?, runs[])`). #09 populates it at the transition boundaries: on **open** = the ids of the trailing failing-streak runs; on **close** = the open incident's `run_ids` plus the 2 closing successes' ids (de-duplicated). Intermediate runs during a sustained outage are **not** appended (the full run span is a dashboard concern, deferred). Acceptance criteria do not test `run_ids` contents; the integration test asserts the boundary ids as a sanity check.

5. **`incidents.check_id` is NOT a foreign key**, mirroring `check_runs` (runs/incidents are polymorphic over check types; the uicheck arrives in #11). Deleting a check therefore does **not** cascade-delete its incidents — pruning is the retention reaper's job (#17). The in-memory store mirrors this (no cascade). A partial unique index `(check_id) WHERE closed_at IS NULL` enforces at most one open incident per check (defense-in-depth; the orchestrator already guards by only opening when none is open).

6. **A project's incidents are resolved by joining `incidents → heartbeat_checks → sites → project`** (incidents currently only originate from heartbeat checks). `listProjectIncidents` returns all of a project's incidents (open + closed), newest-opened first; the API route splits them into `open` / `closed` and the UI computes durations.

7. **Orchestrator placement.** `applyIncidentForRun` lives **in `config-repo`** (it composes the repo's run-history + incident persistence with the pure machine) and is exported from the package, so the worker job and the API run-now route — which already both depend on `@naikan/config-repo` — import one symbol with **no new app-level dependency wiring**. `config-repo` gains a `workspace:*` dependency on `@naikan/incident-machine`. (Considered: a dedicated `incident-orchestrator` package — rejected as heavier wiring for one thin function. Considered: duplicating it in worker + api — rejected, DRY. Mirrors how the pure `resolveEffectiveCheck` decision lives beside the repo that composes it.)

8. **Incidents are not audited** (operational telemetry, like `CheckRun`s) — no `AuditLog` rows.

9. **Test gating.** Logic tasks gate on `bun test` (Bun strips types and does not typecheck, matching the #08 plan's convention — a type error here surfaces at `bun run typecheck` for the SPA and at code review for the kernel). The `pg-store` change has no unit test (it mirrors the in-memory store; `scripts/smoke.ts` against real Postgres is its integration gate). The UI task gates on `bun run typecheck` (svelte-check) + a manual `dev:no-db` walkthrough (a sample open incident is seeded).

## File structure

**New — `packages/incident-machine`** (mirrors `packages/scheduler`):
- `package.json`, `tsconfig.json`
- `src/types.ts` — `RunPoint`, `OpenState`, `MachineInput`, `Transition`.
- `src/machine.ts` *(new)* — `evaluateIncident`, `replayIncidents`, `SUCCESSES_TO_CLOSE`.
- `src/machine.test.ts` *(new)* — the 4 named cases (flap-open-then-recover, sustained outage, false flap, clean 2-success close) + edges.
- `src/index.ts` — public surface.

**Modified — `packages/config-repo`:**
- `src/types.ts` — add `Incident`; add an `incidents` sub-store to `ConfigStore`.
- `src/in-memory-store.ts` — `incidentRows` array + `incidents` sub-store (with the check→site→project join).
- `src/pg-store.ts` — `IncidentRow` + `toIncident` + `incidents` sub-store + `incidentPatchRow`.
- `src/repo.ts` — `getOpenIncident` / `openIncident` / `closeIncident` / `listProjectIncidents` on `ConfigRepo` + impl.
- `src/incident-orchestrator.ts` *(new)* — `applyIncidentForRun` (imports `@naikan/incident-machine`).
- `src/incident-orchestrator.test.ts` *(new)* — the #09 integration criterion (5 fails open / 2 successes close) + run_ids + duration + project listing.
- `src/incidents.test.ts` *(new)* — repo-level incident CRUD + the project join.
- `src/index.ts` — export `Incident` + `applyIncidentForRun`.
- `package.json` — add `"@naikan/incident-machine": "workspace:*"`.

**Modified — `migrations`:**
- `1820000000000_incidents.js` *(new)* — `incidents` table.

**Modified — `apps/worker`:**
- `src/job.ts` — call `applyIncidentForRun` after `recordRun`.
- `src/worker.test.ts` — a test proving the job opens an incident after N fails.

**Modified — `apps/api`:**
- `src/incident/routes.ts` *(new)* — `createIncidentApp` (`GET /api/projects/:id/incidents`).
- `src/incident/routes.test.ts` *(new)* — route auth + open/closed split.
- `src/heartbeat/routes.ts` — call `applyIncidentForRun` after `recordRun` in run-now.
- `src/heartbeat/routes.test.ts` — a test proving run-now opens an incident.
- `src/index.ts` + `src/dev-no-db.ts` — mount `createIncidentApp`; dev-no-db seeds an open incident.

**Modified — `apps/web-admin`:**
- `src/lib/api.ts` — `Incident` type + `getProjectIncidents`.
- `src/ProjectDetail.svelte` — "Incidents" section (open count + oldest opened_at; recovered with duration).

---

## Task 1: Pure `incident-machine` package

**Files:**
- Create: `packages/incident-machine/package.json`
- Create: `packages/incident-machine/tsconfig.json`
- Create: `packages/incident-machine/src/types.ts`
- Create: `packages/incident-machine/src/machine.ts`
- Create: `packages/incident-machine/src/index.ts`
- Test: `packages/incident-machine/src/machine.test.ts`

- [ ] **Step 1: Create the package manifest** (mirrors `packages/scheduler/package.json`)

Create `packages/incident-machine/package.json`:

```json
{
  "name": "@naikan/incident-machine",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "module": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "bun test"
  },
  "devDependencies": {
    "@types/node": "^22.10.0"
  }
}
```

- [ ] **Step 2: Create the tsconfig** (mirrors `packages/scheduler/tsconfig.json` — only the `Date` global is used, so no Bun/Node types)

Create `packages/incident-machine/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    // Pure decision logic — only the `Date` global is used, so no Bun or Node
    // types are needed. Stays runtime-agnostic per ADR-0005 (imported by the
    // Node worker via config-repo), like the other kernel packages.
    "lib": ["ESNext"],
    "types": []
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create the types**

Create `packages/incident-machine/src/types.ts`:

```ts
/**
 * Types for `@naikan/incident-machine` — the pure state machine that turns a
 * check's recent run history + thresholds into one incident state transition
 * (PRD deep module 4, issue #09).
 *
 * The machine reads no clock and no database: the recent runs, the open-incident
 * state, and the fails-to-open threshold are all passed in, so the decision is
 * deterministic and unit-testable. The orchestrator (config-repo) gathers these
 * from the repo after each CheckRun and applies the returned transition.
 */

/** The minimal projection of a CheckRun the machine reasons over. */
export interface RunPoint {
  /** Whether this run passed or failed. */
  status: "pass" | "fail";
  /** When the run started — anchors opened_at / closed_at and the recovery duration. */
  startedAt: Date;
}

/** The currently-open incident's start, or null when no incident is open for the check. */
export interface OpenState {
  openedAt: Date;
}

/** Inputs to one machine evaluation (after the latest run was recorded). */
export interface MachineInput {
  /** Recent runs for one check, oldest → newest; the newest is the run just recorded. */
  runs: RunPoint[];
  /** The open incident's start, or null if none is open. */
  open: OpenState | null;
  /** Consecutive failing runs required to open an incident (effective, inheritance resolved). */
  alertAfterNFails: number;
}

/** What the machine decides to do in response to the latest run. */
export type Transition =
  | { kind: "none" }
  | { kind: "opened"; openedAt: Date }
  | { kind: "still-open" }
  | { kind: "closed-recovered"; openedAt: Date; closedAt: Date; durationMs: number };
```

- [ ] **Step 4: Write the failing tests**

Create `packages/incident-machine/src/machine.test.ts`:

```ts
import { expect, test } from "bun:test";
import { evaluateIncident, replayIncidents, SUCCESSES_TO_CLOSE } from "./machine.ts";
import type { RunPoint, Transition } from "./types.ts";

/** Epoch + the given number of seconds, as a Date. */
const at = (seconds: number): Date => new Date(seconds * 1000);
const fail = (seconds: number): RunPoint => ({ status: "fail", startedAt: at(seconds) });
const pass = (seconds: number): RunPoint => ({ status: "pass", startedAt: at(seconds) });
/** The `kind` sequence — the shape most table cases assert on. */
const kinds = (ts: Transition[]): string[] => ts.map((t) => t.kind);

test("M (successes to close) is the hard-coded 2 from the issue", () => {
  expect(SUCCESSES_TO_CLOSE).toBe(2);
});

// ---- the four named cases from the issue ----

test("clean 2-success close (N=2): none, opened, still-open, closed-recovered", () => {
  const ts = replayIncidents([fail(0), fail(60), pass(120), pass(180)], 2);
  expect(kinds(ts)).toEqual(["none", "opened", "still-open", "closed-recovered"]);
  const opened = ts[1] as Extract<Transition, { kind: "opened" }>;
  expect(opened.openedAt).toEqual(at(0)); // first fail of the streak
  const closed = ts[3] as Extract<Transition, { kind: "closed-recovered" }>;
  expect(closed.openedAt).toEqual(at(0));
  expect(closed.closedAt).toEqual(at(180)); // the 2nd success that confirmed recovery
  expect(closed.durationMs).toBe(180_000);
});

test("flap-open-then-recover (N=1): opens immediately, recovers after two successes", () => {
  const ts = replayIncidents([fail(0), pass(30), pass(60)], 1);
  expect(kinds(ts)).toEqual(["opened", "still-open", "closed-recovered"]);
  const closed = ts[2] as Extract<Transition, { kind: "closed-recovered" }>;
  expect(closed.durationMs).toBe(60_000);
});

test("sustained outage (N=2): opens once, then stays open across further fails", () => {
  const ts = replayIncidents([fail(0), fail(60), fail(120), fail(180)], 2);
  expect(kinds(ts)).toEqual(["none", "opened", "still-open", "still-open"]);
});

test("false flap with a success between fails (N=2) never opens", () => {
  const ts = replayIncidents([fail(0), pass(30), fail(60), pass(90), fail(120)], 2);
  expect(kinds(ts)).toEqual(["none", "none", "none", "none", "none"]);
});

// ---- edges ----

test("empty history yields no transitions", () => {
  expect(replayIncidents([], 2)).toEqual([]);
});

test("a single success while open is not enough to close", () => {
  const ts = replayIncidents([fail(0), pass(30)], 1);
  expect(kinds(ts)).toEqual(["opened", "still-open"]);
});

test("an incident can reopen after a clean recovery (N=1)", () => {
  const ts = replayIncidents([fail(0), pass(30), pass(60), fail(120)], 1);
  expect(kinds(ts)).toEqual(["opened", "still-open", "closed-recovered", "opened"]);
  const reopened = ts[3] as Extract<Transition, { kind: "opened" }>;
  expect(reopened.openedAt).toEqual(at(120));
});

// ---- single-step contract (what the orchestrator calls) ----

test("evaluateIncident opens when the trailing fails reach the threshold", () => {
  const t = evaluateIncident({ runs: [fail(0), fail(60)], open: null, alertAfterNFails: 2 });
  expect(t).toEqual({ kind: "opened", openedAt: at(0) });
});

test("evaluateIncident closes an open incident on two trailing passes", () => {
  const t = evaluateIncident({
    runs: [pass(120), pass(180)],
    open: { openedAt: at(0) },
    alertAfterNFails: 2,
  });
  expect(t).toEqual({ kind: "closed-recovered", openedAt: at(0), closedAt: at(180), durationMs: 180_000 });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `bun test packages/incident-machine/src/machine.test.ts`
Expected: FAIL — `Cannot find module './machine.ts'`.

- [ ] **Step 6: Write the machine**

Create `packages/incident-machine/src/machine.ts`:

```ts
/**
 * Pure incident state machine (issue #09).
 *
 * `evaluateIncident` decides what to do about a check's incident state given its
 * recent runs (oldest → newest), whether an incident is already open, and the
 * fails-to-open threshold. It is the single-step decision the orchestrator calls
 * after every CheckRun. No DB, no clock — everything is passed in.
 *
 * Rules (PRD behavioural rules): open after N consecutive fails; close after 2
 * consecutive successes. `opened_at` is the first fail of the trailing streak;
 * `closed_at` is the latest (recovery-confirming) run; the recovery duration is
 * `closed_at − opened_at`.
 */
import type { MachineInput, RunPoint, Transition } from "./types.ts";

/** Consecutive successful runs that close an open incident (PRD: hard-coded M = 2). */
export const SUCCESSES_TO_CLOSE = 2;

/** Decide the incident transition for the just-recorded run. */
export function evaluateIncident(input: MachineInput): Transition {
  const { runs, open, alertAfterNFails } = input;

  if (open) {
    if (trailingCount(runs, "pass") >= SUCCESSES_TO_CLOSE) {
      const closedAt = runs[runs.length - 1]!.startedAt;
      return {
        kind: "closed-recovered",
        openedAt: open.openedAt,
        closedAt,
        durationMs: closedAt.getTime() - open.openedAt.getTime(),
      };
    }
    return { kind: "still-open" };
  }

  const fails = trailingCount(runs, "fail");
  if (alertAfterNFails >= 1 && fails >= alertAfterNFails) {
    // opened_at = the first run of the trailing failing streak (within the window).
    return { kind: "opened", openedAt: runs[runs.length - fails]!.startedAt };
  }
  return { kind: "none" };
}

/**
 * Fold the single-step machine over a full run history (oldest → newest),
 * threading the open-incident state, and return every transition. This is the
 * table-driven test surface: (history, thresholds) → transitions. Each step sees
 * a trailing window of `max(N, 2)` runs — exactly what the orchestrator feeds in.
 */
export function replayIncidents(history: RunPoint[], alertAfterNFails: number): Transition[] {
  const windowSize = Math.max(alertAfterNFails, SUCCESSES_TO_CLOSE);
  const transitions: Transition[] = [];
  let open: { openedAt: Date } | null = null;
  for (let i = 0; i < history.length; i++) {
    const runs = history.slice(0, i + 1).slice(-windowSize);
    const t = evaluateIncident({ runs, open, alertAfterNFails });
    transitions.push(t);
    if (t.kind === "opened") open = { openedAt: t.openedAt };
    else if (t.kind === "closed-recovered") open = null;
  }
  return transitions;
}

/** Length of the run of `status` at the end of `runs`. */
function trailingCount(runs: RunPoint[], status: "pass" | "fail"): number {
  let n = 0;
  for (let i = runs.length - 1; i >= 0 && runs[i]!.status === status; i--) n++;
  return n;
}
```

- [ ] **Step 7: Create the public surface**

Create `packages/incident-machine/src/index.ts`:

```ts
/** Public surface of `@naikan/incident-machine`. */
export type { MachineInput, OpenState, RunPoint, Transition } from "./types.ts";
export { evaluateIncident, replayIncidents, SUCCESSES_TO_CLOSE } from "./machine.ts";
```

- [ ] **Step 8: Register the workspace package**

The package must be symlinked into `node_modules` before anything imports it.

Run: `bun install`
Expected: completes; `node_modules/@naikan/incident-machine` now resolves.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `bun test packages/incident-machine`
Expected: PASS (all machine tests).

- [ ] **Step 10: Commit**

```bash
git add packages/incident-machine bun.lock
git commit -m "feat(incident-machine): pure open/close state machine (#09)"
```

---

## Task 2: `Incident` domain type + store interface (config-repo)

**Files:**
- Modify: `packages/config-repo/src/types.ts`
- Modify: `packages/config-repo/src/index.ts`

- [ ] **Step 1: Add the `Incident` type**

In `packages/config-repo/src/types.ts`, immediately after the `CheckRunInput` interface (it ends at line 175), add:

```ts
/**
 * An open or resolved incident for a check (PRD data model, issue #09). Opened
 * after N consecutive heartbeat fails, closed after 2 consecutive successes.
 * `checkId` is polymorphic (no FK), mirroring CheckRun. Resolve transitions with
 * `applyIncidentForRun`; never mutate these rows directly outside the repo.
 */
export interface Incident {
  id: string;
  /** The check this incident belongs to (polymorphic — no FK, like CheckRun). */
  checkId: string;
  /** When the failure that opened the incident began. */
  openedAt: Date;
  /** When the incident closed (2 consecutive successes), or null while still open. */
  closedAt: Date | null;
  /** Ids of the CheckRuns spanning the incident (opening fails + closing successes). */
  runIds: string[];
}
```

- [ ] **Step 2: Add the `incidents` sub-store to `ConfigStore`**

In `types.ts`, add a `incidents` sub-store to the `ConfigStore` interface, immediately after the `checkRuns` block (it ends at line 270, `};` after `listByCheck`):

```ts
  incidents: {
    /** The check's currently-open incident (closed_at is null), or null. At most one. */
    getOpenByCheck(checkId: string): Promise<Incident | null>;
    insert(incident: Incident): Promise<Incident>;
    /** Patch closed_at and/or run_ids (used to close an incident). Returns the row, or null. */
    update(id: string, patch: { closedAt?: Date; runIds?: string[] }): Promise<Incident | null>;
    /** Every incident whose check belongs to the project, newest opened first. */
    listByProject(projectId: string): Promise<Incident[]>;
  };
```

- [ ] **Step 3: Export `Incident` from the package index**

In `packages/config-repo/src/index.ts`, add `Incident,` to the type export list from `./types.ts`, in alphabetical position after `HeartbeatCheckPatch,`:

```ts
  HeartbeatCheckPatch,
  Incident,
  Site,
```

- [ ] **Step 4: Verify the package still imports**

Run: `bun test packages/config-repo`
Expected: PASS — existing tests stay green. (The in-memory and pg stores do not yet implement `incidents`; Bun strips types, so the suite still runs. Tasks 3 and 6 add the implementations.)

- [ ] **Step 5: Commit**

```bash
git add packages/config-repo/src/types.ts packages/config-repo/src/index.ts
git commit -m "feat(config-repo): Incident domain type + incidents store interface (#09)"
```

---

## Task 3: In-memory store — incidents sub-store + project join

**Files:**
- Modify: `packages/config-repo/src/in-memory-store.ts`

(No standalone test: exercised through the repo + orchestrator tests in Tasks 4–5.)

- [ ] **Step 1: Import the `Incident` type**

In `packages/config-repo/src/in-memory-store.ts`, extend the type import block (lines 6–18) to include `Incident`, in alphabetical position after `HeartbeatCheckPatch,`:

```ts
  HeartbeatCheckPatch,
  Incident,
  Site,
```

- [ ] **Step 2: Add the incidents backing array**

Add the array next to the other backing collections (after `runs`, line 25):

```ts
  private readonly incidentRows: Incident[] = [];
```

- [ ] **Step 3: Add the `incidents` sub-store**

Add the `incidents` sub-store immediately after the `checkRuns` block (it ends at line 215, `};`):

```ts
  readonly incidents = {
    getOpenByCheck: (checkId: string): Promise<Incident | null> => {
      const open = this.incidentRows.find((i) => i.checkId === checkId && i.closedAt === null);
      return Promise.resolve(open ? cloneIncident(open) : null);
    },

    insert: (incident: Incident): Promise<Incident> => {
      this.incidentRows.push(cloneIncident(incident));
      return Promise.resolve(cloneIncident(incident));
    },

    update: (id: string, patch: { closedAt?: Date; runIds?: string[] }): Promise<Incident | null> => {
      const i = this.incidentRows.find((x) => x.id === id);
      if (!i) return Promise.resolve(null);
      if (patch.closedAt !== undefined) i.closedAt = patch.closedAt;
      if (patch.runIds !== undefined) i.runIds = [...patch.runIds];
      return Promise.resolve(cloneIncident(i));
    },

    // Resolve project ownership via the check → site → project chain (mirrors the
    // SQL join). Incidents whose check was deleted are excluded (no FK; the
    // reaper prunes them in #17).
    listByProject: (projectId: string): Promise<Incident[]> =>
      Promise.resolve(
        this.incidentRows
          .filter((i) => {
            const check = this.checksById.get(i.checkId);
            if (!check) return false;
            return this.sitesById.get(check.siteId)?.projectId === projectId;
          })
          .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())
          .map(cloneIncident),
      ),
  };
```

- [ ] **Step 4: Add the `cloneIncident` helper**

At the bottom of the file, next to `cloneGroup`, add:

```ts
/** Clone an incident, copying the runIds array so callers can't mutate it in place. */
function cloneIncident(i: Incident): Incident {
  return { ...i, runIds: [...i.runIds] };
}
```

- [ ] **Step 5: Verify it type-checks and existing tests stay green**

Run: `bun test packages/config-repo`
Expected: PASS — the in-memory store now satisfies the `incidents` member; existing tests unaffected.

- [ ] **Step 6: Commit**

```bash
git add packages/config-repo/src/in-memory-store.ts
git commit -m "feat(config-repo): in-memory incidents store + project join (#09)"
```

---

## Task 4: Repo — incident methods + tests

**Files:**
- Modify: `packages/config-repo/src/repo.ts`
- Test: `packages/config-repo/src/incidents.test.ts`

- [ ] **Step 1: Write the failing repo test**

Create `packages/config-repo/src/incidents.test.ts`:

```ts
import { beforeEach, expect, test } from "bun:test";
import { createConfigRepo, type ConfigRepo } from "./repo.ts";
import { InMemoryConfigStore } from "./in-memory-store.ts";
import type { Actor } from "./types.ts";

let repo: ConfigRepo;
let projectId: string;
let checkId: string;
const actor: Actor = { id: "user-1" };
const at = (seconds: number): Date => new Date(seconds * 1000);

beforeEach(async () => {
  repo = createConfigRepo(new InMemoryConfigStore());
  const project = await repo.createProject({ name: "Acme" }, actor);
  projectId = project.id;
  const site = await repo.createSite({ projectId, baseUrl: "https://acme.test" }, actor);
  const check = await repo.createCheck({ siteId: site.id, path: "/health" }, actor);
  checkId = check.id;
});

test("getOpenIncident is null when none is open", async () => {
  expect(await repo.getOpenIncident(checkId)).toBeNull();
});

test("openIncident creates an open incident the getter then returns", async () => {
  const opened = await repo.openIncident({ checkId, openedAt: at(0), runIds: ["r1", "r2"] });
  expect(opened.id).toBeTruthy();
  expect(opened.closedAt).toBeNull();
  expect(opened.runIds).toEqual(["r1", "r2"]);
  const open = await repo.getOpenIncident(checkId);
  expect(open?.id).toBe(opened.id);
});

test("closeIncident sets closed_at + run_ids and clears the open getter", async () => {
  const opened = await repo.openIncident({ checkId, openedAt: at(0), runIds: ["r1"] });
  const closed = await repo.closeIncident(opened.id, { closedAt: at(120), runIds: ["r1", "r2", "r3"] });
  expect(closed?.closedAt).toEqual(at(120));
  expect(closed?.runIds).toEqual(["r1", "r2", "r3"]);
  expect(await repo.getOpenIncident(checkId)).toBeNull();
});

test("listProjectIncidents returns the project's incidents, newest opened first", async () => {
  const first = await repo.openIncident({ checkId, openedAt: at(0), runIds: [] });
  await repo.closeIncident(first.id, { closedAt: at(60), runIds: [] });
  await repo.openIncident({ checkId, openedAt: at(120), runIds: [] });

  const all = await repo.listProjectIncidents(projectId);
  expect(all).toHaveLength(2);
  expect(all[0]!.openedAt).toEqual(at(120)); // newest opened first
  expect(all.filter((i) => i.closedAt === null)).toHaveLength(1);
});

test("listProjectIncidents excludes other projects' incidents", async () => {
  await repo.openIncident({ checkId, openedAt: at(0), runIds: [] });
  const other = await repo.createProject({ name: "Globex" }, actor);
  expect(await repo.listProjectIncidents(other.id)).toHaveLength(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/config-repo/src/incidents.test.ts`
Expected: FAIL — `repo.getOpenIncident is not a function`.

- [ ] **Step 3: Add the `Incident` import + the methods to the `ConfigRepo` interface**

In `packages/config-repo/src/repo.ts`, add `Incident,` to the type import block (after `HeartbeatCheckPatch,`, line 30). Then add these methods to the `ConfigRepo` interface, immediately after the `listRuns` line (line 86):

```ts
  /** The check's open incident (closed_at null), or null. (#09) */
  getOpenIncident(checkId: string): Promise<Incident | null>;
  /** Open a new incident for a check. (#09) */
  openIncident(input: { checkId: string; openedAt: Date; runIds: string[] }): Promise<Incident>;
  /** Close an open incident, recording its closed_at + run span. (#09) */
  closeIncident(id: string, input: { closedAt: Date; runIds: string[] }): Promise<Incident | null>;
  /** Every incident for a project (open + closed), newest opened first. (#09) */
  listProjectIncidents(projectId: string): Promise<Incident[]>;
```

- [ ] **Step 4: Implement the methods**

In the object returned by `createConfigRepo`, add the following immediately after the `listRuns` line (line 345, `listRuns: (checkId, limit) => store.checkRuns.listByCheck(checkId, limit),`). Incidents are operational telemetry — not audited (like `recordRun`):

```ts
    getOpenIncident: (checkId) => store.incidents.getOpenByCheck(checkId),
    openIncident: ({ checkId, openedAt, runIds }) =>
      store.incidents.insert({ id: genId(), checkId, openedAt, closedAt: null, runIds }),
    closeIncident: (id, { closedAt, runIds }) => store.incidents.update(id, { closedAt, runIds }),
    listProjectIncidents: (projectId) => store.incidents.listByProject(projectId),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/config-repo/src/incidents.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/config-repo/src/repo.ts packages/config-repo/src/incidents.test.ts
git commit -m "feat(config-repo): incident persistence methods (#09)"
```

---

## Task 5: Orchestrator + integration test (config-repo)

**Files:**
- Modify: `packages/config-repo/package.json`
- Create: `packages/config-repo/src/incident-orchestrator.ts`
- Modify: `packages/config-repo/src/index.ts`
- Test: `packages/config-repo/src/incident-orchestrator.test.ts`

- [ ] **Step 1: Add the `@naikan/incident-machine` dependency**

In `packages/config-repo/package.json`, add the workspace dependency to the `dependencies` block (next to `postgres`):

```json
  "dependencies": {
    "@naikan/incident-machine": "workspace:*",
    "postgres": "^3.4.5"
  },
```

Then run: `bun install`
Expected: completes; `config-repo` can now import `@naikan/incident-machine`.

- [ ] **Step 2: Write the failing integration test (the #09 acceptance criterion)**

Create `packages/config-repo/src/incident-orchestrator.test.ts`:

```ts
import { beforeEach, expect, test } from "bun:test";
import { createConfigRepo, type ConfigRepo } from "./repo.ts";
import { InMemoryConfigStore } from "./in-memory-store.ts";
import { applyIncidentForRun } from "./incident-orchestrator.ts";
import type { Actor, CheckRunStatus } from "./types.ts";

let repo: ConfigRepo;
let projectId: string;
let checkId: string;
const actor: Actor = { id: "system" };
const at = (seconds: number): Date => new Date(seconds * 1000);

/** Record a heartbeat run at `seconds`, then run the orchestrator (mirrors the job). */
async function recordAndApply(status: CheckRunStatus, seconds: number): Promise<void> {
  await repo.recordRun({
    checkId,
    checkType: "heartbeat",
    startedAt: at(seconds),
    finishedAt: at(seconds),
    status,
    latencyMs: 0,
    error: status === "fail" ? "down" : null,
  });
  await applyIncidentForRun({ repo, checkId });
}

beforeEach(async () => {
  repo = createConfigRepo(new InMemoryConfigStore());
  const project = await repo.createProject({ name: "Acme" }, actor);
  projectId = project.id;
  const site = await repo.createSite({ projectId, baseUrl: "https://acme.test" }, actor);
  // alertAfterNFails = 5 → five consecutive fails open one incident (the issue's criterion).
  const check = await repo.createCheck({ siteId: site.id, path: "/health", alertAfterNFails: 5 }, actor);
  checkId = check.id;
});

test("five fails open exactly one incident; two successes close it", async () => {
  for (let i = 0; i < 4; i++) await recordAndApply("fail", i * 60);
  expect(await repo.getOpenIncident(checkId)).toBeNull(); // 4 < 5, still none

  await recordAndApply("fail", 4 * 60); // the 5th fail opens it
  const open = await repo.getOpenIncident(checkId);
  expect(open).not.toBeNull();
  expect(open!.openedAt).toEqual(at(0)); // first fail of the streak
  expect(open!.runIds).toHaveLength(5); // the five failing runs
  expect((await repo.listProjectIncidents(projectId)).filter((x) => x.closedAt === null)).toHaveLength(1);

  await recordAndApply("pass", 300); // one success: not enough to close
  expect(await repo.getOpenIncident(checkId)).not.toBeNull();

  await recordAndApply("pass", 360); // second success closes it
  expect(await repo.getOpenIncident(checkId)).toBeNull();

  const closed = (await repo.listProjectIncidents(projectId)).find((x) => x.closedAt !== null)!;
  expect(closed.closedAt).toEqual(at(360));
  expect(closed.runIds).toHaveLength(7); // 5 fails + 2 closing successes
});

test("a flap that never reaches the threshold opens nothing", async () => {
  // alertAfterNFails = 5, but never 5 consecutive fails.
  await recordAndApply("fail", 0);
  await recordAndApply("pass", 60);
  await recordAndApply("fail", 120);
  expect(await repo.getOpenIncident(checkId)).toBeNull();
  expect(await repo.listProjectIncidents(projectId)).toHaveLength(0);
});

test("applyIncidentForRun is a no-op for an unknown check", async () => {
  expect(await applyIncidentForRun({ repo, checkId: "missing" })).toBeNull();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test packages/config-repo/src/incident-orchestrator.test.ts`
Expected: FAIL — `Cannot find module './incident-orchestrator.ts'`.

- [ ] **Step 4: Write the orchestrator**

Create `packages/config-repo/src/incident-orchestrator.ts`:

```ts
/**
 * Incident orchestrator (issue #09) — the thin glue that runs after every
 * CheckRun write (worker job + API "Run now"). It reads the I/O the pure
 * `@naikan/incident-machine` needs — the check's *effective* alert-after-N-fails
 * (CheckGroup inheritance resolved, #08), the recent run tail, and the open
 * incident — runs the machine, and persists the single resulting transition.
 *
 * The decision lives entirely in the machine; this only does the reads/writes.
 * Alerting is out of scope (#10): incidents transition silently here.
 */
import { evaluateIncident, SUCCESSES_TO_CLOSE, type RunPoint } from "@naikan/incident-machine";
import type { ConfigRepo } from "./repo.ts";
import type { CheckRun, Incident } from "./types.ts";

export interface ApplyIncidentDeps {
  repo: ConfigRepo;
  /** The check whose just-recorded run should be evaluated. */
  checkId: string;
}

/**
 * Resolve incident state after a CheckRun: open on N consecutive fails, close on
 * 2 consecutive successes, else no-op. Returns the affected Incident, or null
 * when nothing changed (or the check no longer exists).
 */
export async function applyIncidentForRun(deps: ApplyIncidentDeps): Promise<Incident | null> {
  const { repo, checkId } = deps;

  const effective = await repo.getEffectiveCheck(checkId);
  if (!effective) return null;
  const n = effective.alertAfterNFails;

  // Enough history to detect both open (N trailing fails) and close (2 passes).
  const windowSize = Math.max(n, SUCCESSES_TO_CLOSE);
  const tail = (await repo.listRuns(checkId, windowSize)).slice().reverse(); // oldest → newest
  const open = await repo.getOpenIncident(checkId);

  const runs: RunPoint[] = tail.map((r) => ({ status: r.status, startedAt: r.startedAt }));
  const transition = evaluateIncident({
    runs,
    open: open ? { openedAt: open.openedAt } : null,
    alertAfterNFails: n,
  });

  if (transition.kind === "opened") {
    return repo.openIncident({
      checkId,
      openedAt: transition.openedAt,
      runIds: trailingFailIds(tail),
    });
  }
  if (transition.kind === "closed-recovered" && open) {
    const closingPassIds = tail.slice(tail.length - SUCCESSES_TO_CLOSE).map((r) => r.id);
    return repo.closeIncident(open.id, {
      closedAt: transition.closedAt,
      runIds: [...new Set([...open.runIds, ...closingPassIds])],
    });
  }
  return null;
}

/** Ids of the trailing failing-streak runs (oldest → newest) — the opening window. */
function trailingFailIds(runs: CheckRun[]): string[] {
  const ids: string[] = [];
  for (let i = runs.length - 1; i >= 0 && runs[i]!.status === "fail"; i--) ids.unshift(runs[i]!.id);
  return ids;
}
```

- [ ] **Step 5: Export the orchestrator from the package index**

In `packages/config-repo/src/index.ts`, add after the `resolveEffectiveCheck` export block (the final `export { ... } from "./effective.ts";`):

```ts
export { applyIncidentForRun, type ApplyIncidentDeps } from "./incident-orchestrator.ts";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test packages/config-repo`
Expected: PASS — the orchestrator integration test plus all existing config-repo tests.

- [ ] **Step 7: Commit**

```bash
git add packages/config-repo/package.json packages/config-repo/src/incident-orchestrator.ts packages/config-repo/src/incident-orchestrator.test.ts packages/config-repo/src/index.ts bun.lock
git commit -m "feat(config-repo): incident orchestrator wiring the pure machine (#09)"
```

---

## Task 6: Postgres store — incidents sub-store

**Files:**
- Modify: `packages/config-repo/src/pg-store.ts`

(No unit test — the pg-store mirrors the in-memory store and is covered by `scripts/smoke.ts` against real Postgres. Gate: `bun test` stays green + it type-checks.)

- [ ] **Step 1: Import the `Incident` type + add the `IncidentRow` interface**

In `packages/config-repo/src/pg-store.ts`, add `Incident,` to the type import block (after `HeartbeatCheckPatch,`, line 23). After the `CheckRunRow` interface (it ends at line 84), add:

```ts
interface IncidentRow {
  id: string;
  check_id: string;
  opened_at: Date;
  closed_at: Date | null;
  run_ids: string[];
}
```

- [ ] **Step 2: Add the `toIncident` mapper**

Next to `toCheckRun` (after it, around line 161), add:

```ts
function toIncident(r: IncidentRow): Incident {
  return {
    id: r.id,
    checkId: r.check_id,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    runIds: r.run_ids,
  };
}
```

- [ ] **Step 3: Add the `incidents` sub-store**

In the object returned by `createPgConfigStore`, add the `incidents` sub-store immediately after the `checkRuns` block (it ends at line 382, `},`):

```ts
    incidents: {
      async getOpenByCheck(checkId) {
        const sql = getSql();
        const rows = await sql<IncidentRow[]>`
          select * from incidents
          where check_id = ${checkId} and closed_at is null
          order by opened_at desc limit 1`;
        return rows[0] ? toIncident(rows[0]) : null;
      },

      async insert(incident) {
        const sql = getSql();
        const rows = await sql<IncidentRow[]>`
          insert into incidents (id, check_id, opened_at, closed_at, run_ids)
          values (${incident.id}, ${incident.checkId}, ${incident.openedAt},
                  ${incident.closedAt}, ${incident.runIds})
          returning *`;
        return toIncident(rows[0]!);
      },

      async update(id, patch) {
        const sql = getSql();
        const row = incidentPatchRow(patch);
        const rows = Object.keys(row).length
          ? await sql<IncidentRow[]>`update incidents set ${sql(row)} where id = ${id} returning *`
          : await sql<IncidentRow[]>`select * from incidents where id = ${id} limit 1`;
        return rows[0] ? toIncident(rows[0]) : null;
      },

      // Join incident → check → site → project (incidents originate from heartbeat
      // checks; the uicheck source arrives in #11).
      async listByProject(projectId) {
        const sql = getSql();
        const rows = await sql<IncidentRow[]>`
          select i.* from incidents i
          join heartbeat_checks hc on hc.id = i.check_id
          join sites s on s.id = hc.site_id
          where s.project_id = ${projectId}
          order by i.opened_at desc`;
        return rows.map(toIncident);
      },
    },
```

- [ ] **Step 4: Add the `incidentPatchRow` helper**

At the bottom of the file (next to `groupPatchRow`), add:

```ts
/** Maps an incident patch to snake_case columns for a dynamic `update ... set` write. */
function incidentPatchRow(patch: { closedAt?: Date; runIds?: string[] }): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.closedAt !== undefined) row.closed_at = patch.closedAt;
  if (patch.runIds !== undefined) row.run_ids = patch.runIds;
  return row;
}
```

- [ ] **Step 5: Verify it type-checks and the suite is green**

Run: `bun test packages/config-repo`
Expected: PASS (the pg-store isn't hit by these tests, but the file must compile — a type error fails the import).

- [ ] **Step 6: Commit**

```bash
git add packages/config-repo/src/pg-store.ts
git commit -m "feat(config-repo): pg incidents store (#09)"
```

---

## Task 7: Migration — `incidents` table

**Files:**
- Create: `migrations/1820000000000_incidents.js`

- [ ] **Step 1: Write the migration**

Create `migrations/1820000000000_incidents.js` (the timestamp follows `1810000000000_check-groups.js`, the latest):

```js
/**
 * Incidents (issue #09).
 *
 * - `check_id` is intentionally NOT a foreign key: incidents are polymorphic over
 *   check types (heartbeat now; uicheck in #11), mirroring `check_runs`. Deleting
 *   a check does not cascade here; the retention reaper (#17) prunes old rows.
 * - `closed_at` null means the incident is still open. The partial unique index
 *   enforces at most one open incident per check (the orchestrator also guards).
 * - `run_ids` is the CheckRun span (opening fails + closing successes), per the
 *   PRD `Incident(... runs[])` data model.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable("incidents", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    check_id: { type: "uuid", notNull: true },
    opened_at: { type: "timestamptz", notNull: true },
    closed_at: { type: "timestamptz" },
    run_ids: { type: "uuid[]", notNull: true, default: pgm.func("ARRAY[]::uuid[]") },
  });
  pgm.createIndex("incidents", "check_id");
  pgm.createIndex("incidents", "check_id", {
    unique: true,
    where: "closed_at IS NULL",
    name: "incidents_one_open_per_check",
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable("incidents");
};
```

- [ ] **Step 2: Sanity-check the migration parses** (no DB required — Node just loads it)

Run: `node --check migrations/1820000000000_incidents.js`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add migrations/1820000000000_incidents.js
git commit -m "feat(db): incidents table migration (#09)"
```

---

## Task 8: Worker — wire the orchestrator into the job

**Files:**
- Modify: `apps/worker/src/job.ts`
- Test: `apps/worker/src/worker.test.ts`

- [ ] **Step 1: Write the failing wiring test**

In `apps/worker/src/worker.test.ts`, append at the end of the file (after the last test, line 225):

```ts
// ---- incident orchestration (issue #09): the job applies a transition per run ----

test("runHeartbeatJob opens an incident after N consecutive fails", async () => {
  const project = await repo.createProject({ name: "Acme" }, actor);
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  const check = await repo.createCheck(
    { siteId: site.id, path: "/health", alertAfterNFails: 2 },
    actor,
  );
  const failing: RunCheck = () =>
    Promise.resolve<CheckRunResult>({
      status: "fail",
      startedAt: new Date(0),
      finishedAt: new Date(0),
      latencyMs: 0,
      error: "down",
    });

  await runHeartbeatJob(check.id, { repo, runCheck: failing });
  expect(await repo.getOpenIncident(check.id)).toBeNull(); // 1 fail < 2

  await runHeartbeatJob(check.id, { repo, runCheck: failing });
  expect(await repo.getOpenIncident(check.id)).not.toBeNull(); // 2 fails → opened
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/worker/src/worker.test.ts`
Expected: FAIL — the second assertion fails (`getOpenIncident` is still null: the job records runs but does not yet apply incidents).

- [ ] **Step 3: Wire the orchestrator into the job**

In `apps/worker/src/job.ts`, add `applyIncidentForRun` to the existing `@naikan/config-repo` import (line 14):

```ts
import { applyIncidentForRun, type CheckRun, type ConfigRepo, type HeartbeatCheck } from "@naikan/config-repo";
```

Then replace the final `recordRun` + `return` (lines 51–59) with:

```ts
  const run = await repo.recordRun({
    checkId: check.id,
    checkType: "heartbeat",
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    status: result.status,
    latencyMs: result.latencyMs,
    error: result.error,
  });
  // After each CheckRun, resolve incident state (open on N fails / close on 2 passes).
  await applyIncidentForRun({ repo, checkId: check.id });
  return run;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/worker`
Expected: PASS — the new test plus all existing worker tests (the orchestrator no-ops while runs pass, so the scheduling tests are unaffected).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/job.ts apps/worker/src/worker.test.ts
git commit -m "feat(worker): apply incident transition after each CheckRun (#09)"
```

---

## Task 9: API — run-now wiring + project incidents route

**Files:**
- Modify: `apps/api/src/heartbeat/routes.ts`
- Test: `apps/api/src/heartbeat/routes.test.ts`
- Create: `apps/api/src/incident/routes.ts`
- Test: `apps/api/src/incident/routes.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/dev-no-db.ts`

- [ ] **Step 1: Write the failing run-now wiring test**

In `apps/api/src/heartbeat/routes.test.ts`, append at the end of the file (after the last test, line 218):

```ts
// ---- incident orchestration (issue #09): run-now applies a transition ----

test("run-now opens an incident after N consecutive failing runs", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const { check } = (await (await createCheck(cookie, { alertAfterNFails: 2 })).json()) as {
    check: { id: string };
  };
  stubResult = { ...stubResult, status: "fail", error: "HTTP 500" };

  await app.request(`/api/checks/${check.id}/run`, { method: "POST", headers: { cookie } });
  expect(await repo.getOpenIncident(check.id)).toBeNull(); // 1 fail < 2

  await app.request(`/api/checks/${check.id}/run`, { method: "POST", headers: { cookie } });
  expect(await repo.getOpenIncident(check.id)).not.toBeNull(); // 2 fails → opened
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/api/src/heartbeat/routes.test.ts`
Expected: FAIL — the second assertion fails (run-now records runs but does not apply incidents).

- [ ] **Step 3: Wire the orchestrator into run-now**

In `apps/api/src/heartbeat/routes.ts`, add `applyIncidentForRun` to the existing `@naikan/config-repo` import (lines 15–22) — add it as the first named import after the `{`:

```ts
import {
  applyIncidentForRun,
  ValidationError,
  type Actor,
  type ConfigRepo,
  type HeartbeatCheck,
  type HeartbeatCheckInput,
  type HeartbeatCheckPatch,
} from "@naikan/config-repo";
```

Then, in the run-now handler, add the orchestrator call between `recordRun` and the response (after line 113, before `return c.json({ run });`):

```ts
    // After each CheckRun, resolve incident state (open on N fails / close on 2 passes).
    await applyIncidentForRun({ repo, checkId: check.id });
    return c.json({ run });
```

- [ ] **Step 4: Run the heartbeat test to verify it passes**

Run: `bun test apps/api/src/heartbeat/routes.test.ts`
Expected: PASS — the new test plus all existing heartbeat route tests.

- [ ] **Step 5: Write the failing incidents-route test**

Create `apps/api/src/incident/routes.test.ts`:

```ts
import { beforeEach, expect, test } from "bun:test";
import { applyIncidentForRun, createConfigRepo, InMemoryConfigStore, type ConfigRepo } from "@naikan/config-repo";
import { createIncidentApp } from "./routes.ts";
import { createAuth, type Auth } from "../auth/service.ts";
import { InMemorySessionStore, InMemoryUserStore } from "../auth/in-memory-stores.ts";

let app: ReturnType<typeof createIncidentApp>;
let auth: Auth;
let repo: ConfigRepo;
let projectId: string;
let checkId: string;
const at = (seconds: number): Date => new Date(seconds * 1000);

beforeEach(async () => {
  auth = createAuth({ users: new InMemoryUserStore(), sessions: new InMemorySessionStore() });
  await auth.createUser({ email: "viewer@example.com", password: "viewerpass", role: "viewer" });
  repo = createConfigRepo(new InMemoryConfigStore());
  const project = await repo.createProject({ name: "Acme" }, { id: null });
  projectId = project.id;
  const site = await repo.createSite({ projectId, baseUrl: "https://acme.test" }, { id: null });
  const check = await repo.createCheck({ siteId: site.id, path: "/health", alertAfterNFails: 1 }, { id: null });
  checkId = check.id;
  app = createIncidentApp({ auth, repo });
});

async function cookieFor(email: string, password: string): Promise<string> {
  const result = await auth.login(email, password);
  return `cm_session=${result!.session.id}`;
}

async function recordAndApply(status: "pass" | "fail", seconds: number): Promise<void> {
  await repo.recordRun({
    checkId,
    checkType: "heartbeat",
    startedAt: at(seconds),
    finishedAt: at(seconds),
    status,
    latencyMs: 0,
    error: status === "fail" ? "down" : null,
  });
  await applyIncidentForRun({ repo, checkId });
}

test("listing incidents requires a session (401)", async () => {
  expect((await app.request(`/api/projects/${projectId}/incidents`)).status).toBe(401);
});

test("unknown project returns 404", async () => {
  const cookie = await cookieFor("viewer@example.com", "viewerpass");
  expect((await app.request(`/api/projects/nope/incidents`, { headers: { cookie } })).status).toBe(404);
});

test("viewer sees open then closed incidents split out", async () => {
  const cookie = await cookieFor("viewer@example.com", "viewerpass");

  await recordAndApply("fail", 0); // N=1 → opens immediately
  let res = await app.request(`/api/projects/${projectId}/incidents`, { headers: { cookie } });
  expect(res.status).toBe(200);
  let body = (await res.json()) as { open: unknown[]; closed: unknown[] };
  expect(body.open).toHaveLength(1);
  expect(body.closed).toHaveLength(0);

  await recordAndApply("pass", 60);
  await recordAndApply("pass", 120); // 2 successes → closes
  res = await app.request(`/api/projects/${projectId}/incidents`, { headers: { cookie } });
  body = (await res.json()) as { open: unknown[]; closed: { closedAt: string }[] };
  expect(body.open).toHaveLength(0);
  expect(body.closed).toHaveLength(1);
  expect(body.closed[0]!.closedAt).toBeTruthy();
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `bun test apps/api/src/incident/routes.test.ts`
Expected: FAIL — `Cannot find module './routes.ts'`.

- [ ] **Step 7: Write the incidents route**

Create `apps/api/src/incident/routes.ts`:

```ts
/**
 * HTTP surface for incidents (issue #09), mounted under `/api`. Read-only — open
 * + closed incidents for a project (PRD viewer stories 17/18), available to any
 * authenticated user. Incidents are opened/closed by the orchestrator after each
 * CheckRun; there are no write routes here.
 */
import { Hono } from "hono";
import { requireAuth, type AuthEnv } from "../auth/middleware.ts";
import type { Auth } from "../auth/service.ts";
import type { ConfigRepo } from "@naikan/config-repo";

export interface IncidentAppOptions {
  auth: Auth;
  repo: ConfigRepo;
}

export function createIncidentApp(opts: IncidentAppOptions) {
  const { auth, repo } = opts;
  const app = new Hono<AuthEnv>();
  const read = [requireAuth(auth)] as const;

  app.get("/api/projects/:id/incidents", ...read, async (c) => {
    const project = await repo.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    const all = await repo.listProjectIncidents(project.id);
    const open = all.filter((i) => i.closedAt === null);
    const closed = all
      .filter((i) => i.closedAt !== null)
      .sort((a, b) => b.closedAt!.getTime() - a.closedAt!.getTime());
    return c.json({ open, closed });
  });

  return app;
}
```

- [ ] **Step 8: Run the incidents-route test to verify it passes**

Run: `bun test apps/api/src/incident/routes.test.ts`
Expected: PASS.

- [ ] **Step 9: Mount the route in the production server**

In `apps/api/src/index.ts`, add the import after the `createGroupApp` import (line 10):

```ts
import { createIncidentApp } from "./incident/routes.ts";
```

Then mount it after the `createGroupApp` route (line 43, before the static-serving block):

```ts
// Incidents read API (issue #09). Shares the single config-repo.
app.route("/", createIncidentApp({ auth, repo: config }));
```

- [ ] **Step 10: Mount + seed in the no-DB dev server**

In `apps/api/src/dev-no-db.ts`, add `applyIncidentForRun` to the `@naikan/config-repo` import (line 18):

```ts
import { applyIncidentForRun, createConfigRepo, InMemoryConfigStore } from "@naikan/config-repo";
```

Add the route import after the `createGroupApp` import (line 23):

```ts
import { createIncidentApp } from "./incident/routes.ts";
```

After the `repo.createCheck(...)` seed call (it ends at line 65), seed an open incident so the UI shows one (the sample group inherits `defaultAlertAfterNFails: 2`):

```ts
// Seed an open incident on the sample check (2 failing runs → opens; #09) so the
// per-project overview has something to show in the no-DB walkthrough.
const sampleCheck = (await repo.listChecks(sampleSite.id))[0]!;
for (let i = 0; i < 2; i++) {
  await repo.recordRun({
    checkId: sampleCheck.id,
    checkType: "heartbeat",
    startedAt: new Date(Date.now() - (2 - i) * 300_000),
    finishedAt: new Date(Date.now() - (2 - i) * 300_000),
    status: "fail",
    latencyMs: 0,
    error: "connection refused",
  });
  await applyIncidentForRun({ repo, checkId: sampleCheck.id });
}
```

Then mount the route after the `createGroupApp` route (line 72):

```ts
app.route("/", createIncidentApp({ auth, repo }));
```

- [ ] **Step 11: Run the full API + worker suites**

Run: `bun test apps/api apps/worker`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/heartbeat/routes.ts apps/api/src/heartbeat/routes.test.ts apps/api/src/incident apps/api/src/index.ts apps/api/src/dev-no-db.ts
git commit -m "feat(api): apply incidents on run-now + project incidents route (#09)"
```

---

## Task 10: web-admin — incidents on the per-project overview

**Files:**
- Modify: `apps/web-admin/src/lib/api.ts`
- Modify: `apps/web-admin/src/ProjectDetail.svelte`

- [ ] **Step 1: Add the `Incident` type + fetch helper to the API project**

In `apps/web-admin/src/lib/api.ts`, append at the end of the file (after the `deleteGroup` function, line 354):

```ts
// ---- Incidents (issue #09) ----

export interface Incident {
  id: string;
  checkId: string;
  openedAt: string;
  closedAt: string | null;
  runIds: string[];
}

/** Open + closed incidents for a project (newest first). */
export async function getProjectIncidents(
  projectId: string,
): Promise<{ open: Incident[]; closed: Incident[] }> {
  const res = await fetch(`/api/projects/${projectId}/incidents`);
  if (!res.ok) throw await errorFrom(res, "Could not load incidents");
  return (await res.json()) as { open: Incident[]; closed: Incident[] };
}
```

- [ ] **Step 2: Load incidents in `ProjectDetail.svelte`**

In `apps/web-admin/src/ProjectDetail.svelte`, add incident state after the `groups` state (line 31):

```ts
  // Incidents (issue #09): open (count + oldest) + recently recovered (duration).
  let openIncidents = $state<api.Incident[]>([]);
  let closedIncidents = $state<api.Incident[]>([]);
```

Replace the `load()` body's `Promise.all` block (lines 90–95) with one that also fetches incidents:

```ts
      const [c, s, g, incidents] = await Promise.all([
        api.getProject(projectId),
        api.listSites(projectId),
        api.listGroups(projectId),
        api.getProjectIncidents(projectId),
      ]);
      project = c;
      sites = s;
      groups = g;
      openIncidents = incidents.open;
      closedIncidents = incidents.closed;
      if (session.isAdmin) managers = await api.listUsers();
```

- [ ] **Step 3: Add the incident formatting helpers**

In `ProjectDetail.svelte`, add these next to `hostOf` (after it, around line 270, still inside `<script>`):

```ts
  function formatWhen(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  /** Humanise a millisecond span as `Xm` or `Xh Ym`. */
  function formatDuration(ms: number): string {
    const mins = Math.max(0, Math.round(ms / 60_000));
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  /** ISO timestamps sort lexicographically, so reduce picks the earliest opened. */
  function oldestOpenedAt(): string | null {
    if (openIncidents.length === 0) return null;
    return openIncidents.reduce((min, i) => (i.openedAt < min ? i.openedAt : min), openIncidents[0].openedAt);
  }

  function downSinceOpened(i: api.Incident): string {
    return formatDuration(Date.now() - new Date(i.openedAt).getTime());
  }

  function recoveredDuration(i: api.Incident): string {
    if (!i.closedAt) return "—";
    return formatDuration(new Date(i.closedAt).getTime() - new Date(i.openedAt).getTime());
  }
```

- [ ] **Step 4: Add the Incidents section markup**

In `ProjectDetail.svelte`, insert this `<section>` immediately after the edit-form block's closing `{/if}` (line 352) and before the `Check groups` section (`<section class="section">` at line 354). It leads with a loud-red heading when something is open and stays silent otherwise (DESIGN.md "silent green, loud red"; no boxes):

```svelte
  <section class="section">
    <div class="section-head" class:incident-open={openIncidents.length > 0}>
      <h2>Incidents</h2>
      <span class="n">{openIncidents.length} open</span>
      <div class="spacer"></div>
    </div>

    {#if openIncidents.length > 0}
      <ul class="rowlist">
        {#each openIncidents as inc (inc.id)}
          <li>
            <div class="datarow">
              <div class="dr-name">
                <span class="nm">Opened {formatWhen(inc.openedAt)}</span>
                <span class="sub">down for {downSinceOpened(inc)}</span>
              </div>
              <span class="pill pill-fail">Open</span>
            </div>
          </li>
        {/each}
      </ul>
      {#if oldestOpenedAt()}
        <p class="sub">Oldest opened {formatWhen(oldestOpenedAt()!)}.</p>
      {/if}
    {:else}
      <p class="empty">No open incidents.</p>
    {/if}

    {#if closedIncidents.length > 0}
      <h3 class="subhead">Recently recovered</h3>
      <ul class="rowlist">
        {#each closedIncidents as inc (inc.id)}
          <li>
            <div class="datarow">
              <div class="dr-name">
                <span class="nm">Recovered {formatWhen(inc.closedAt!)}</span>
                <span class="sub">opened {formatWhen(inc.openedAt)} · down for {recoveredDuration(inc)}</span>
              </div>
              <span class="pill pill-ok">Recovered</span>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
```

- [ ] **Step 5: Add the scoped styles**

In `ProjectDetail.svelte`, add a `<style>` block at the very end of the file (the component currently has none; these use real `app.css` tokens):

```svelte
<style>
  /* Loud-red heading when an incident is open; silent otherwise (DESIGN.md). */
  .section-head.incident-open h2 {
    color: var(--fail-ink);
  }
  .subhead {
    margin: var(--s4) 0 var(--s2);
    font-size: var(--t-label);
    font-weight: 600;
    color: var(--ink-muted);
  }
</style>
```

- [ ] **Step 6: Typecheck the SPA**

Run: `bun run typecheck`
Expected: PASS (svelte-check reports no errors).

- [ ] **Step 7: Manual walkthrough (the UI gate)**

Run: `bun run dev:no-db` then open `http://localhost:3000`, log in as `admin@example.com` / `admin1234`, go to Projects → "Northwind Coffee". Verify the **Incidents** section shows a red "Incidents · 1 open" heading, one open row ("Opened … · down for …" with a red **Open** pill), and an "Oldest opened …" line. (Stop the server with Ctrl-C when done.)

- [ ] **Step 8: Commit**

```bash
git add apps/web-admin/src/lib/api.ts apps/web-admin/src/ProjectDetail.svelte
git commit -m "feat(web-admin): incidents on the per-project overview (#09)"
```

---

## Final verification

- [ ] **Run the whole test suite**

Run: `bun test`
Expected: PASS across `incident-machine`, `config-repo`, `apps/worker`, `apps/api`.

- [ ] **Typecheck the SPA**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Tick the acceptance criteria in the issue** (`docs/mvp/issues/09-incident-machine.md`) and mark its `Status:` per the triage workflow.

---

## Self-review

**Spec coverage (issue acceptance criteria):**

- *`Incident` migration applied* → Task 7 (`1820000000000_incidents.js`).
- *`incident-machine` is pure — no DB, no clock except injected* → Task 1 (package depends on nothing; `evaluateIncident`/`replayIncidents` take all inputs as args; `tsconfig` has `types: []`).
- *Orchestrator hook runs after each CheckRun write, applies any transition* → Task 5 (`applyIncidentForRun`), wired in Task 8 (worker job) and Task 9 (API run-now), each proved by a wiring test.
- *Open incidents listed on per-project overview (count + oldest opened_at)* → Task 10 (`{openIncidents.length} open` + `oldestOpenedAt()`).
- *Closed incidents shown with computed duration* → Task 10 (`recoveredDuration`).
- *Table-driven unit tests on `incident-machine`: flap-open-then-recover, sustained outage, false flap with 1 success between fails, clean 2-success close* → Task 1 (four named tests via `replayIncidents`).
- *Integration test: 5 fail CheckRuns → one Incident open; 2 successes → closed* → Task 5 (`incident-orchestrator.test.ts`, `alertAfterNFails: 5`).
- *Blocked by #07* → #07 (scheduler + worker tick) is merged; the orchestrator attaches to the existing `recordRun` path.

**Placeholder scan:** every code step contains complete code; commands have expected output; no "TBD"/"handle errors"/"similar to Task N".

**Type consistency:** `RunPoint { status, startedAt }`, `Transition` (`none` | `opened{openedAt}` | `still-open` | `closed-recovered{openedAt,closedAt,durationMs}`), `SUCCESSES_TO_CLOSE`, and `Incident { id, checkId, openedAt, closedAt, runIds }` are used identically across the machine, the store interface, the in-memory + pg stores, the repo methods (`getOpenIncident`/`openIncident`/`closeIncident`/`listProjectIncidents`), the orchestrator (`applyIncidentForRun({ repo, checkId })`), the API route, and the SPA (`getProjectIncidents`). `alertAfterNFails` is always read from `getEffectiveCheck` (resolved, never the raw nullable column). The pg `incidents.update` patch shape `{ closedAt?, runIds? }` matches the in-memory store and `incidentPatchRow`.
