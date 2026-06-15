import { beforeEach, expect, test } from "bun:test";
import { createConfigRepo, ValidationError, type ConfigRepo } from "./repo.ts";
import { InMemoryConfigStore } from "./in-memory-store.ts";
import type { Actor } from "./types.ts";

let repo: ConfigRepo;
let siteId: string;
const actor: Actor = { id: "user-1" };

beforeEach(async () => {
  repo = createConfigRepo(new InMemoryConfigStore());
  const project = await repo.createProject({ name: "Acme" }, actor);
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  siteId = site.id;
});

function uiInput(over: Record<string, unknown> = {}) {
  return { siteId, path: "/pricing", ...over };
}

// ---- create + defaults ----

test("createUICheck stores and returns a check with id + timestamps", async () => {
  const c = await repo.createUICheck(uiInput(), actor);
  expect(c.id).toBeTruthy();
  expect(c.siteId).toBe(siteId);
  expect(c.path).toBe("/pricing");
  expect(c.createdAt).toBeInstanceOf(Date);
  expect(await repo.getUICheck(c.id)).toMatchObject({ id: c.id, path: "/pricing" });
});

test("createUICheck fills the PRD defaults for an otherwise-empty check", async () => {
  const c = await repo.createUICheck({ siteId }, actor);
  expect(c.path).toBe("/");
  expect(c.groupId).toBeNull();
  expect(c.viewports).toEqual(["mobile", "tablet", "desktop"]);
  expect(c.selectors).toEqual([]);
  expect(c.ignoreRegions).toEqual([]);
  expect(c.perfBudget).toEqual({ lcpMs: 2500, pageWeightBytes: 3 * 1024 * 1024, maxRequests: 100 });
  expect(c.severityLoad).toBe("critical");
  expect(c.severityConsole).toBe("warning");
  expect(c.severitySelector).toBe("warning");
  expect(c.severityPerf).toBe("warning");
  expect(c.baselineImageRef).toBeNull();
  expect(c.diffThreshold).toBeGreaterThanOrEqual(0);
});

test("createUICheck round-trips all configured fields", async () => {
  const c = await repo.createUICheck(
    uiInput({
      viewports: ["desktop", "mobile"],
      selectors: ["#hero", ".cta"],
      ignoreRegions: [".carousel"],
      perfBudget: { lcpMs: 2000, pageWeightBytes: 1_000_000, maxRequests: 50 },
      diffThreshold: 0.05,
      severityLoad: "critical",
      severityConsole: "critical",
    }),
    actor,
  );
  expect(c.viewports).toEqual(["desktop", "mobile"]);
  expect(c.selectors).toEqual(["#hero", ".cta"]);
  expect(c.ignoreRegions).toEqual([".carousel"]);
  expect(c.perfBudget).toEqual({ lcpMs: 2000, pageWeightBytes: 1_000_000, maxRequests: 50 });
  expect(c.diffThreshold).toBe(0.05);
  expect(c.severityConsole).toBe("critical");
});

// ---- group assignment (cross-project guard, mirrors heartbeat) ----

test("createUICheck rejects a groupId from a different project", async () => {
  const other = await repo.createProject({ name: "Globex" }, actor);
  const otherGroup = await repo.createGroup({ projectId: other.id, name: "x" }, actor);
  const err = await repo.createUICheck(uiInput({ groupId: otherGroup.id }), actor).catch((e) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).field).toBe("groupId");
});

// ---- list ----

test("listUIChecks returns checks under a site", async () => {
  await repo.createUICheck(uiInput(), actor);
  await repo.createUICheck(uiInput({ path: "/about" }), actor);
  expect(await repo.listUIChecks(siteId)).toHaveLength(2);
});

test("listAllUIChecks returns every check across all sites and projects", async () => {
  await repo.createUICheck(uiInput(), actor);
  const other = await repo.createProject({ name: "Globex" }, actor);
  const otherSite = await repo.createSite({ projectId: other.id, baseUrl: "https://globex.test" }, actor);
  await repo.createUICheck({ siteId: otherSite.id, path: "/login" }, actor);

  const all = await repo.listAllUIChecks();
  expect(all).toHaveLength(2);
  expect(all.map((c) => c.path).sort()).toEqual(["/login", "/pricing"]);
});

// ---- validation ----

test("createUICheck requires a siteId", async () => {
  const err = await repo.createUICheck(uiInput({ siteId: "" }), actor).catch((e) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).field).toBe("siteId");
});

test("createUICheck rejects a path that does not start with /", async () => {
  const err = await repo.createUICheck(uiInput({ path: "pricing" }), actor).catch((e) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).field).toBe("path");
});

test("createUICheck rejects an unknown viewport label", async () => {
  const err = await repo.createUICheck(uiInput({ viewports: ["mobile", "watch"] }), actor).catch((e) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).field).toBe("viewports");
});

test("createUICheck rejects an empty viewport set", async () => {
  const err = await repo.createUICheck(uiInput({ viewports: [] }), actor).catch((e) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).field).toBe("viewports");
});

test("createUICheck rejects a diffThreshold outside 0..1", async () => {
  await expect(repo.createUICheck(uiInput({ diffThreshold: 1.5 }), actor)).rejects.toBeInstanceOf(
    ValidationError,
  );
});

test("createUICheck rejects an invalid severity value", async () => {
  const err = await repo.createUICheck(uiInput({ severityLoad: "fatal" }), actor).catch((e) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).field).toBe("severityLoad");
});

test("createUICheck rejects a non-positive perf budget", async () => {
  await expect(
    repo.createUICheck(uiInput({ perfBudget: { lcpMs: 0 } }), actor),
  ).rejects.toBeInstanceOf(ValidationError);
});

// ---- update / delete ----

test("updateUICheck applies a partial patch and leaves other fields", async () => {
  const c = await repo.createUICheck(uiInput(), actor);
  const u = await repo.updateUICheck(c.id, { diffThreshold: 0.2 }, actor);
  expect(u?.diffThreshold).toBe(0.2);
  expect(u?.path).toBe("/pricing"); // untouched
});

test("updateUICheck returns null for an unknown id", async () => {
  expect(await repo.updateUICheck("missing", { diffThreshold: 0.2 }, actor)).toBeNull();
});

test("updateUICheck revalidates patched fields", async () => {
  const c = await repo.createUICheck(uiInput(), actor);
  await expect(repo.updateUICheck(c.id, { viewports: ["nope"] }, actor)).rejects.toBeInstanceOf(
    ValidationError,
  );
});

test("deleteUICheck removes the check and returns true", async () => {
  const c = await repo.createUICheck(uiInput(), actor);
  expect(await repo.deleteUICheck(c.id, actor)).toBe(true);
  expect(await repo.getUICheck(c.id)).toBeNull();
});

test("deleteUICheck returns false for an unknown id", async () => {
  expect(await repo.deleteUICheck("missing", actor)).toBe(false);
});

// ---- cascade ----

test("deleting a site cascades its UI checks", async () => {
  const c = await repo.createUICheck(uiInput(), actor);
  await repo.deleteSite(siteId, actor);
  expect(await repo.getUICheck(c.id)).toBeNull();
});

// ---- audit ----

test("createUICheck writes a create audit row under the uicheck entity", async () => {
  const c = await repo.createUICheck(uiInput(), actor);
  const row = (await repo.listAudit()).find(
    (e) => e.entityType === "uicheck" && e.action === "create",
  )!;
  expect(row.entityId).toBe(c.id);
  expect(row.userId).toBe("user-1");
  expect(row.diff.after).toMatchObject({ path: "/pricing" });
});

test("updateUICheck audits only the changed fields", async () => {
  const c = await repo.createUICheck(uiInput(), actor);
  await repo.updateUICheck(c.id, { diffThreshold: 0.3 }, actor);
  const row = (await repo.listAudit()).find(
    (e) => e.entityType === "uicheck" && e.action === "update",
  )!;
  expect(row.diff.after).toMatchObject({ diffThreshold: 0.3 });
});

// ---- promote to baseline (#12) ----

test("promoteUICheckBaseline sets baselineImageRef and returns the updated check", async () => {
  const c = await repo.createUICheck(uiInput(), actor);
  const ref = "projects/x/checks/y/baseline/manifest.json";
  const u = await repo.promoteUICheckBaseline(c.id, { baselineImageRef: ref, runId: "run-9" }, actor);
  expect(u?.baselineImageRef).toBe(ref);
  expect((await repo.getUICheck(c.id))?.baselineImageRef).toBe(ref);
});

test("promoteUICheckBaseline returns null for an unknown id", async () => {
  const u = await repo.promoteUICheckBaseline(
    "missing",
    { baselineImageRef: "k", runId: "run-9" },
    actor,
  );
  expect(u).toBeNull();
});

test("promoteUICheckBaseline audits who, the new baseline ref, and which run was promoted", async () => {
  const c = await repo.createUICheck(uiInput(), actor);
  const ref = "projects/x/checks/y/baseline/manifest.json";
  await repo.promoteUICheckBaseline(c.id, { baselineImageRef: ref, runId: "run-9" }, actor);
  const row = (await repo.listAudit()).find(
    (e) => e.entityType === "uicheck" && e.action === "update" && e.entityId === c.id,
  )!;
  expect(row.userId).toBe("user-1");
  expect(row.diff.after).toMatchObject({ baselineImageRef: ref, promotedFromRunId: "run-9" });
  expect(row.diff.before).toMatchObject({ baselineImageRef: null });
});
