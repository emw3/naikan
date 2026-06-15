/**
 * Retention reaper (issue #17). Mirrors the digest/ui-job test pattern: in-memory
 * config-repo + a recording fake store + an injected clock, so the whole reap path
 * is exercised with no real S3.
 *
 * The defining test seeds UI-check runs straddling a project's retention boundary
 * and asserts the reaper deletes exactly the past-retention run artifacts, tombstones
 * those runs, and leaves the in-window run AND the approved baseline untouched.
 */
import { beforeEach, expect, test } from "bun:test";
import { createConfigRepo, InMemoryConfigStore, type Actor, type ConfigRepo } from "@naikan/config-repo";
import { artifactKeys, TOMBSTONE_REF } from "@naikan/baseline-store";
import { runRetentionReaper } from "./reaper-job.ts";

const actor: Actor = { id: "system" };
const DAY = 24 * 60 * 60 * 1000;

let repo: ConfigRepo;

beforeEach(() => {
  repo = createConfigRepo(new InMemoryConfigStore());
});

/** A store that records puts and serves list()/delete()/get() from an in-memory map. */
function fakeStore() {
  const objects = new Map<string, Buffer>();
  const deleted: string[] = [];
  return {
    objects,
    deleted,
    put(key: string): Promise<void> {
      objects.set(key, Buffer.from(key));
      return Promise.resolve();
    },
    list(prefix: string): Promise<string[]> {
      return Promise.resolve([...objects.keys()].filter((k) => k.startsWith(prefix)));
    },
    delete(key: string): Promise<void> {
      objects.delete(key);
      deleted.push(key);
      return Promise.resolve();
    },
  };
}

/**
 * Seed one UI run: record the CheckRun (the repo assigns its id), then write a
 * screenshot + manifest under that run's subtree and point `artifactsRef` at the
 * manifest. Returns the assigned run id so assertions can address it.
 */
async function seedRun(
  store: ReturnType<typeof fakeStore>,
  projectId: string,
  checkId: string,
  startedAt: Date,
): Promise<string> {
  const run = await repo.recordRun({
    checkId,
    checkType: "uicheck",
    startedAt,
    finishedAt: startedAt,
    status: "pass",
    latencyMs: 1,
  });
  await store.put(artifactKeys.runScreenshot(projectId, checkId, run.id, "desktop"));
  const manifestKey = artifactKeys.runManifest(projectId, checkId, run.id);
  await store.put(manifestKey);
  await repo.setRunArtifactsRef(run.id, manifestKey);
  return run.id;
}

test("reaps only past-retention run artifacts, tombstones those runs, and exempts the baseline", async () => {
  const now = new Date("2026-06-04T00:00:00Z");
  const project = await repo.createProject({ name: "Acme", retentionDays: 1 }, actor);
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  const check = await repo.createUICheck({ siteId: site.id, path: "/" }, actor);
  const store = fakeStore();

  // One run two days old (past the 1-day window) and one twelve hours old (inside it).
  const oldId = await seedRun(store, project.id, check.id, new Date(now.getTime() - 2 * DAY));
  const freshId = await seedRun(store, project.id, check.id, new Date(now.getTime() - DAY / 2));

  // An approved baseline lives outside the runs/ subtree — must survive the reap.
  const baselineKey = artifactKeys.baseline(project.id, check.id, "desktop");
  await store.put(baselineKey);
  await store.put(artifactKeys.baselineManifest(project.id, check.id));

  const result = await runRetentionReaper({ repo, store, now: () => now });

  // The old run's artifacts are gone; the fresh run's remain.
  expect(await store.list(artifactKeys.runPrefix(project.id, check.id, oldId))).toEqual([]);
  expect(await store.list(artifactKeys.runPrefix(project.id, check.id, freshId))).not.toEqual([]);
  // The baseline subtree is untouched.
  expect(store.objects.has(baselineKey)).toBe(true);
  expect(store.deleted).not.toContain(baselineKey);

  // The old run is tombstoned; the fresh run still points at its live manifest.
  const runs = await repo.listRuns(check.id);
  const old = runs.find((r) => r.id === oldId);
  const fresh = runs.find((r) => r.id === freshId);
  expect(old?.artifactsRef).toBe(TOMBSTONE_REF);
  expect(fresh?.artifactsRef).toBe(artifactKeys.runManifest(project.id, check.id, freshId));

  expect(result.runsReaped).toBe(1);
  expect(result.keysDeleted).toBe(2);
  expect(result.projects).toBe(1);
});

test("is idempotent — a second pass re-tombstones nothing already expired", async () => {
  const now = new Date("2026-06-04T00:00:00Z");
  const project = await repo.createProject({ name: "Acme", retentionDays: 1 }, actor);
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  const check = await repo.createUICheck({ siteId: site.id, path: "/" }, actor);
  const store = fakeStore();
  await seedRun(store, project.id, check.id, new Date(now.getTime() - 2 * DAY));

  await runRetentionReaper({ repo, store, now: () => now });
  const second = await runRetentionReaper({ repo, store, now: () => now });

  expect(second.runsReaped).toBe(0);
});

test("a run exactly at the cutoff is kept — the window is exclusive on the fresh side", async () => {
  const now = new Date("2026-06-04T00:00:00Z");
  const project = await repo.createProject({ name: "Acme", retentionDays: 1 }, actor);
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  const check = await repo.createUICheck({ siteId: site.id, path: "/" }, actor);
  const store = fakeStore();
  // Exactly one retention window old → not "older than" the window, so it survives.
  const atCutoff = await seedRun(store, project.id, check.id, new Date(now.getTime() - DAY));

  const result = await runRetentionReaper({ repo, store, now: () => now });

  expect(result.runsReaped).toBe(0);
  expect(store.objects.has(artifactKeys.runManifest(project.id, check.id, atCutoff))).toBe(true);
});

test("a project with a longer retention window keeps the same-aged run", async () => {
  const now = new Date("2026-06-04T00:00:00Z");
  const project = await repo.createProject({ name: "Acme", retentionDays: 30 }, actor);
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  const check = await repo.createUICheck({ siteId: site.id, path: "/" }, actor);
  const store = fakeStore();
  const oldId = await seedRun(store, project.id, check.id, new Date(now.getTime() - 2 * DAY));

  const result = await runRetentionReaper({ repo, store, now: () => now });

  expect(result.runsReaped).toBe(0);
  expect(store.objects.has(artifactKeys.runManifest(project.id, check.id, oldId))).toBe(true);
});
