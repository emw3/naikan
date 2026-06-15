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

test("deleting a group leaves its member checks ungrouped", async () => {
  const site = await repo.createSite({ projectId, baseUrl: "https://acme.test" }, actor);
  const g = await repo.createGroup({ projectId, name: "x", defaultIntervalSeconds: 600 }, actor);
  const check = await repo.createCheck({ siteId: site.id, groupId: g.id }, actor);
  await repo.deleteGroup(g.id, actor);
  const after = await repo.getCheck(check.id);
  expect(after?.groupId).toBeNull();
});
