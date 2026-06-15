/**
 * config-repo support for the daily digest (issue #15):
 *  - per-Project `digestEmailEnabled` / `digestSlackEnabled` toggles (default on),
 *  - `listRunsInWindow` — runs for a check within a half-open `[from, to)` window
 *    (the digest needs a full day, which blows past `listRuns`' 50-row cap),
 *  - `getUser` — resolve a Project's assigned manager to an email for delivery.
 */
import { beforeEach, expect, test } from "bun:test";
import { createConfigRepo, type ConfigRepo } from "./repo.ts";
import { InMemoryConfigStore } from "./in-memory-store.ts";
import type { Actor } from "./types.ts";

let store: InMemoryConfigStore;
let repo: ConfigRepo;
const actor: Actor = { id: "user-1" };

beforeEach(() => {
  store = new InMemoryConfigStore();
  repo = createConfigRepo(store);
});

// ---- digest toggles ----

test("createProject defaults both digest toggles to true", async () => {
  const c = await repo.createProject({ name: "Acme" }, actor);
  expect(c.digestEmailEnabled).toBe(true);
  expect(c.digestSlackEnabled).toBe(true);
});

test("createProject honours explicit digest toggles", async () => {
  const c = await repo.createProject(
    { name: "Acme", digestEmailEnabled: false, digestSlackEnabled: false },
    actor,
  );
  expect(c.digestEmailEnabled).toBe(false);
  expect(c.digestSlackEnabled).toBe(false);
});

test("updateProject patches a digest toggle and audits the change", async () => {
  const c = await repo.createProject({ name: "Acme" }, actor);
  const updated = await repo.updateProject(c.id, { digestSlackEnabled: false }, actor);
  expect(updated?.digestSlackEnabled).toBe(false);
  expect(updated?.digestEmailEnabled).toBe(true);
  const audit = await repo.listAudit();
  expect(audit[0]?.diff.after).toMatchObject({ digestSlackEnabled: false });
});

// ---- listRunsInWindow ----

async function seedCheck(): Promise<string> {
  const project = await repo.createProject({ name: "Acme" }, actor);
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  const check = await repo.createCheck({ siteId: site.id, path: "/health" }, actor);
  return check.id;
}

const recordAt = async (checkId: string, startedAt: Date) =>
  repo.recordRun({
    checkId,
    checkType: "heartbeat",
    startedAt,
    finishedAt: startedAt,
    status: "pass",
    latencyMs: 0,
    error: null,
  });

test("listRunsInWindow returns only runs with from <= startedAt < to", async () => {
  const checkId = await seedCheck();
  const from = new Date("2026-06-02T00:00:00Z");
  const to = new Date("2026-06-03T00:00:00Z");
  await recordAt(checkId, new Date(from.getTime() - 1)); // before
  await recordAt(checkId, from); // inclusive lower bound
  await recordAt(checkId, new Date("2026-06-02T12:00:00Z")); // inside
  await recordAt(checkId, to); // exclusive upper bound

  const runs = await repo.listRunsInWindow(checkId, from, to);
  expect(runs).toHaveLength(2);
  expect(runs.every((r) => r.startedAt.getTime() >= from.getTime() && r.startedAt.getTime() < to.getTime())).toBe(true);
});

test("listRunsInWindow returns more than the 50-row listRuns cap", async () => {
  const checkId = await seedCheck();
  const from = new Date("2026-06-02T00:00:00Z");
  const to = new Date("2026-06-03T00:00:00Z");
  for (let i = 0; i < 60; i++) {
    await recordAt(checkId, new Date(from.getTime() + i * 60_000));
  }
  expect(await repo.listRunsInWindow(checkId, from, to)).toHaveLength(60);
  expect(await repo.listRuns(checkId)).toHaveLength(50); // default cap unchanged
});

// ---- getUser ----

test("getUser resolves a seeded user, excludes soft-deleted, null for missing", async () => {
  store.seedUser({ id: "mgr-1", email: "manager@example.com", role: "admin", deletedAt: null });
  store.seedUser({ id: "gone", email: "old@example.com", role: "viewer", deletedAt: new Date() });

  expect(await repo.getUser("mgr-1")).toEqual({ id: "mgr-1", email: "manager@example.com", role: "admin" });
  expect(await repo.getUser("gone")).toBeNull();
  expect(await repo.getUser("nope")).toBeNull();
});
