import { beforeEach, expect, test } from "bun:test";
import { createConfigRepo, ValidationError, type ConfigRepo } from "./repo.ts";
import { InMemoryConfigStore } from "./in-memory-store.ts";
import type { Actor, CheckRunInput } from "./types.ts";

let repo: ConfigRepo;
let siteId: string;
const actor: Actor = { id: "user-1" };

beforeEach(async () => {
  repo = createConfigRepo(new InMemoryConfigStore());
  const project = await repo.createProject({ name: "Acme" }, actor);
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  siteId = site.id;
});

function checkInput(over: Record<string, unknown> = {}) {
  return { siteId, path: "/health", ...over };
}

// ---- create + defaults ----

test("createCheck stores and returns a check with id + timestamps", async () => {
  const c = await repo.createCheck(checkInput(), actor);
  expect(c.id).toBeTruthy();
  expect(c.siteId).toBe(siteId);
  expect(c.path).toBe("/health");
  expect(c.createdAt).toBeInstanceOf(Date);
  expect(await repo.getCheck(c.id)).toMatchObject({ id: c.id, path: "/health" });
});

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

test("listChecks returns checks under a site", async () => {
  await repo.createCheck(checkInput(), actor);
  await repo.createCheck(checkInput({ path: "/status" }), actor);
  expect(await repo.listChecks(siteId)).toHaveLength(2);
});

// ---- listAllChecks (cross-site, used by the scheduler tick in #07) ----

test("listAllChecks returns checks across every site", async () => {
  await repo.createCheck(checkInput(), actor);
  const project2 = await repo.createProject({ name: "Globex" }, actor);
  const site2 = await repo.createSite({ projectId: project2.id, baseUrl: "https://globex.test" }, actor);
  const c2 = await repo.createCheck({ siteId: site2.id, path: "/up" }, actor);

  const all = await repo.listAllChecks();
  expect(all).toHaveLength(2);
  const ids = all.map((c) => c.id);
  expect(ids).toContain(c2.id);
  // spans both sites, not just the one from beforeEach
  expect(new Set(all.map((c) => c.siteId)).size).toBe(2);
});

test("listAllChecks is empty when no checks exist", async () => {
  expect(await repo.listAllChecks()).toEqual([]);
});

// ---- validation ----

test("createCheck requires a siteId", async () => {
  const err = await repo.createCheck(checkInput({ siteId: "" }), actor).catch((e) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).field).toBe("siteId");
});

test("createCheck rejects a path that does not start with /", async () => {
  const err = await repo.createCheck(checkInput({ path: "health" }), actor).catch((e) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).field).toBe("path");
});

test("createCheck rejects a non-positive interval", async () => {
  await expect(repo.createCheck(checkInput({ intervalSeconds: 0 }), actor)).rejects.toBeInstanceOf(
    ValidationError,
  );
});

test("createCheck rejects a non-positive alertAfterNFails", async () => {
  await expect(
    repo.createCheck(checkInput({ alertAfterNFails: 0 }), actor),
  ).rejects.toBeInstanceOf(ValidationError);
});

test("createCheck rejects an invalid regex body assertion", async () => {
  const err = await repo
    .createCheck(checkInput({ bodyAssertion: { kind: "regex", pattern: "[" } }), actor)
    .catch((e) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).field).toBe("bodyAssertion");
});

test("createCheck rejects an unknown body assertion kind", async () => {
  await expect(
    repo.createCheck(checkInput({ bodyAssertion: { kind: "xpath", pattern: "x" } }), actor),
  ).rejects.toBeInstanceOf(ValidationError);
});

test("createCheck accepts a valid jsonpath body assertion", async () => {
  const c = await repo.createCheck(
    checkInput({ bodyAssertion: { kind: "jsonpath", pattern: "status", equals: "green" } }),
    actor,
  );
  expect(c.bodyAssertion).toEqual({ kind: "jsonpath", pattern: "status", equals: "green" });
});

// ---- update / delete ----

test("updateCheck applies a partial patch and bumps updatedAt", async () => {
  const c = await repo.createCheck(checkInput(), actor);
  const u = await repo.updateCheck(c.id, { certCheck: true }, actor);
  expect(u?.certCheck).toBe(true);
  expect(u?.path).toBe("/health"); // untouched
});

test("updateCheck returns null for an unknown id", async () => {
  expect(await repo.updateCheck("missing", { certCheck: true }, actor)).toBeNull();
});

test("updateCheck revalidates patched fields", async () => {
  const c = await repo.createCheck(checkInput(), actor);
  await expect(repo.updateCheck(c.id, { intervalSeconds: -1 }, actor)).rejects.toBeInstanceOf(
    ValidationError,
  );
});

test("deleteCheck removes the check and returns true", async () => {
  const c = await repo.createCheck(checkInput(), actor);
  expect(await repo.deleteCheck(c.id, actor)).toBe(true);
  expect(await repo.getCheck(c.id)).toBeNull();
});

test("deleteCheck returns false for an unknown id", async () => {
  expect(await repo.deleteCheck("missing", actor)).toBe(false);
});

// ---- cascade ----

test("deleting a site cascades its checks", async () => {
  const c = await repo.createCheck(checkInput(), actor);
  const site = (await repo.getSite(siteId))!;
  await repo.deleteSite(site.id, actor);
  expect(await repo.getCheck(c.id)).toBeNull();
});

// ---- audit ----

test("createCheck writes a create audit row under the heartbeat_check entity", async () => {
  const c = await repo.createCheck(checkInput(), actor);
  const row = (await repo.listAudit()).find(
    (e) => e.entityType === "heartbeat_check" && e.action === "create",
  )!;
  expect(row.entityId).toBe(c.id);
  expect(row.userId).toBe("user-1");
  expect(row.diff.after).toMatchObject({ path: "/health" });
});

test("updateCheck audits only the changed fields", async () => {
  const c = await repo.createCheck(checkInput(), actor);
  await repo.updateCheck(c.id, { dnsCheck: true }, actor);
  const row = (await repo.listAudit()).find(
    (e) => e.entityType === "heartbeat_check" && e.action === "update",
  )!;
  expect(row.diff.before).toEqual({ dnsCheck: false });
  expect(row.diff.after).toEqual({ dnsCheck: true });
});

// ---- check runs ----

function runInput(over: Partial<CheckRunInput> = {}): CheckRunInput {
  return {
    checkId: "check-1",
    checkType: "heartbeat",
    startedAt: new Date(1000),
    finishedAt: new Date(1100),
    status: "pass",
    latencyMs: 100,
    error: null,
    ...over,
  };
}

test("recordRun persists a CheckRun and listRuns returns it", async () => {
  const check = await repo.createCheck(checkInput(), actor);
  const run = await repo.recordRun(runInput({ checkId: check.id }));
  expect(run.id).toBeTruthy();
  expect(run.status).toBe("pass");
  const runs = await repo.listRuns(check.id);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.id).toBe(run.id);
});

test("listRuns returns runs newest first", async () => {
  const check = await repo.createCheck(checkInput(), actor);
  await repo.recordRun(runInput({ checkId: check.id, startedAt: new Date(1000), status: "pass" }));
  await repo.recordRun(runInput({ checkId: check.id, startedAt: new Date(2000), status: "fail" }));
  const runs = await repo.listRuns(check.id);
  expect(runs[0]!.status).toBe("fail");
  expect(runs[1]!.status).toBe("pass");
});

test("recordRun does not write an audit row", async () => {
  const check = await repo.createCheck(checkInput(), actor);
  const before = (await repo.listAudit()).length;
  await repo.recordRun(runInput({ checkId: check.id }));
  expect((await repo.listAudit()).length).toBe(before);
});

test("setRunArtifactsRef rewrites a run's artifacts_ref (the retention reaper's tombstone, #17)", async () => {
  const check = await repo.createCheck(checkInput(), actor);
  const run = await repo.recordRun(
    runInput({ checkId: check.id, checkType: "uicheck", artifactsRef: "projects/c/checks/k/runs/r/manifest.json" }),
  );

  const updated = await repo.setRunArtifactsRef(run.id, "tombstone://expired");
  expect(updated?.artifactsRef).toBe("tombstone://expired");

  // The rewrite is persisted, and the rest of the run is untouched.
  const reread = (await repo.listRuns(check.id)).find((r) => r.id === run.id);
  expect(reread?.artifactsRef).toBe("tombstone://expired");
  expect(reread?.status).toBe(run.status);
});

test("setRunArtifactsRef is operational telemetry — it writes no audit row", async () => {
  const check = await repo.createCheck(checkInput(), actor);
  const run = await repo.recordRun(runInput({ checkId: check.id }));
  const before = (await repo.listAudit()).length;
  await repo.setRunArtifactsRef(run.id, "tombstone://expired");
  expect((await repo.listAudit()).length).toBe(before);
});

test("setRunArtifactsRef returns null for an unknown run", async () => {
  expect(await repo.setRunArtifactsRef("nope", "tombstone://expired")).toBeNull();
});

// ---- latest-run freshness (self-monitoring /health, #18) ----

test("latestRunAt returns the newest run's finishedAt across all checks", async () => {
  const a = await repo.createCheck(checkInput({ path: "/a" }), actor);
  const b = await repo.createCheck(checkInput({ path: "/b" }), actor);
  await repo.recordRun(runInput({ checkId: a.id, finishedAt: new Date(1000) }));
  await repo.recordRun(runInput({ checkId: b.id, finishedAt: new Date(5000) }));
  await repo.recordRun(runInput({ checkId: a.id, finishedAt: new Date(3000) }));
  expect(await repo.latestRunAt()).toEqual(new Date(5000));
});

test("latestRunAt returns null when no runs exist", async () => {
  expect(await repo.latestRunAt()).toBeNull();
});
