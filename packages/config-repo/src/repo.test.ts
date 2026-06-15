import { beforeEach, expect, test } from "bun:test";
import { createConfigRepo, ValidationError, type ConfigRepo } from "./repo.ts";
import { InMemoryConfigStore } from "./in-memory-store.ts";
import type { Actor } from "./types.ts";

let repo: ConfigRepo;
const actor: Actor = { id: "user-1" };

beforeEach(() => {
  repo = createConfigRepo(new InMemoryConfigStore());
});

/** A valid project input with the fields under test set explicitly. */
function projectInput(over: Record<string, unknown> = {}) {
  return {
    name: "Acme Coffee",
    contacts: "Mara Ortiz, ops@acme.test",
    slackChannel: "#project-acme",
    alertEmails: ["alerts@acme.test"],
    retentionDays: 90,
    assignedManagerId: "user-1",
    ...over,
  };
}

// ---- Project create ----

test("createProject stores and returns a project with id + timestamps", async () => {
  const c = await repo.createProject(projectInput(), actor);
  expect(c.id).toBeTruthy();
  expect(c.name).toBe("Acme Coffee");
  expect(c.retentionDays).toBe(90);
  expect(c.alertEmails).toEqual(["alerts@acme.test"]);
  expect(c.createdAt).toBeInstanceOf(Date);
  expect(await repo.getProject(c.id)).toMatchObject({ id: c.id, name: "Acme Coffee" });
});

test("createProject defaults retentionDays to 90 and contacts to empty", async () => {
  const c = await repo.createProject({ name: "Bare" }, actor);
  expect(c.retentionDays).toBe(90);
  expect(c.contacts).toBe("");
  expect(c.alertEmails).toEqual([]);
  expect(c.slackChannel).toBeNull();
  expect(c.assignedManagerId).toBeNull();
});

// ---- Project validation ----

test("createProject rejects a blank name", async () => {
  const err = await repo.createProject(projectInput({ name: "   " }), actor).catch((e) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).field).toBe("name");
});

test("createProject rejects a non-positive retentionDays", async () => {
  await expect(repo.createProject(projectInput({ retentionDays: 0 }), actor)).rejects.toBeInstanceOf(
    ValidationError,
  );
  await expect(repo.createProject(projectInput({ retentionDays: -5 }), actor)).rejects.toBeInstanceOf(
    ValidationError,
  );
});

test("createProject rejects a non-integer retentionDays", async () => {
  await expect(
    repo.createProject(projectInput({ retentionDays: 3.5 }), actor),
  ).rejects.toBeInstanceOf(ValidationError);
});

test("createProject rejects a malformed alert email", async () => {
  const err = await repo
    .createProject(projectInput({ alertEmails: ["ok@acme.test", "not-an-email"] }), actor)
    .catch((e) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).field).toBe("alertEmails");
});

test("createProject rejects a malformed slack channel", async () => {
  const err = await repo
    .createProject(projectInput({ slackChannel: "no-hash" }), actor)
    .catch((e) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).field).toBe("slackChannel");
});

test("createProject treats an empty slack channel as unset (null)", async () => {
  const c = await repo.createProject(projectInput({ slackChannel: "" }), actor);
  expect(c.slackChannel).toBeNull();
});

// ---- Project update / delete ----

test("updateProject applies a partial patch and bumps updatedAt", async () => {
  const c = await repo.createProject(projectInput(), actor);
  const updated = await repo.updateProject(c.id, { name: "Acme Renamed" }, actor);
  expect(updated?.name).toBe("Acme Renamed");
  expect(updated?.contacts).toBe(c.contacts); // untouched
});

test("updateProject returns null for an unknown id", async () => {
  expect(await repo.updateProject("missing", { name: "x" }, actor)).toBeNull();
});

test("updateProject revalidates patched fields", async () => {
  const c = await repo.createProject(projectInput(), actor);
  await expect(repo.updateProject(c.id, { retentionDays: -1 }, actor)).rejects.toBeInstanceOf(
    ValidationError,
  );
});

test("deleteProject removes the project and returns true", async () => {
  const c = await repo.createProject(projectInput(), actor);
  expect(await repo.deleteProject(c.id, actor)).toBe(true);
  expect(await repo.getProject(c.id)).toBeNull();
});

test("deleteProject returns false for an unknown id", async () => {
  expect(await repo.deleteProject("missing", actor)).toBe(false);
});

// ---- Site CRUD + validation ----

test("createSite stores a site under a project", async () => {
  const c = await repo.createProject(projectInput(), actor);
  const s = await repo.createSite({ projectId: c.id, baseUrl: "https://acme.test" }, actor);
  expect(s.id).toBeTruthy();
  expect(s.projectId).toBe(c.id);
  expect(await repo.listSites(c.id)).toHaveLength(1);
});

test("createSite rejects a non-http(s) base URL", async () => {
  const c = await repo.createProject(projectInput(), actor);
  const err = await repo
    .createSite({ projectId: c.id, baseUrl: "ftp://acme.test" }, actor)
    .catch((e) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).field).toBe("baseUrl");
});

test("createSite rejects a malformed base URL", async () => {
  const c = await repo.createProject(projectInput(), actor);
  await expect(
    repo.createSite({ projectId: c.id, baseUrl: "not a url" }, actor),
  ).rejects.toBeInstanceOf(ValidationError);
});

test("updateSite changes the base URL", async () => {
  const c = await repo.createProject(projectInput(), actor);
  const s = await repo.createSite({ projectId: c.id, baseUrl: "https://acme.test" }, actor);
  const u = await repo.updateSite(s.id, { baseUrl: "https://staging.acme.test" }, actor);
  expect(u?.baseUrl).toBe("https://staging.acme.test");
});

test("deleteSite removes the site", async () => {
  const c = await repo.createProject(projectInput(), actor);
  const s = await repo.createSite({ projectId: c.id, baseUrl: "https://acme.test" }, actor);
  expect(await repo.deleteSite(s.id, actor)).toBe(true);
  expect(await repo.listSites(c.id)).toHaveLength(0);
});

// ---- Audit logging ----

test("createProject writes a create audit row attributed to the actor", async () => {
  const c = await repo.createProject(projectInput(), actor);
  const log = await repo.listAudit();
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({
    entityType: "project",
    entityId: c.id,
    action: "create",
    userId: "user-1",
  });
  expect(log[0]!.diff.after).toMatchObject({ name: "Acme Coffee" });
});

test("updateProject writes an update audit row with before/after of changed fields only", async () => {
  const c = await repo.createProject(projectInput(), actor);
  await repo.updateProject(c.id, { name: "Acme Renamed" }, actor);
  const log = await repo.listAudit();
  const update = log.find((e) => e.action === "update")!;
  expect(update.diff.before).toEqual({ name: "Acme Coffee" });
  expect(update.diff.after).toEqual({ name: "Acme Renamed" });
});

test("deleteProject writes a delete audit row with the prior snapshot", async () => {
  const c = await repo.createProject(projectInput(), actor);
  await repo.deleteProject(c.id, actor);
  const del = (await repo.listAudit()).find((e) => e.action === "delete")!;
  expect(del.entityType).toBe("project");
  expect(del.diff.before).toMatchObject({ name: "Acme Coffee" });
});

test("a failed (rejected) write logs no audit row", async () => {
  await repo.createProject(projectInput({ name: "" }), actor).catch(() => {});
  expect(await repo.listAudit()).toHaveLength(0);
});

test("site mutations are audited under the site entity type", async () => {
  const c = await repo.createProject(projectInput(), actor);
  const s = await repo.createSite({ projectId: c.id, baseUrl: "https://acme.test" }, actor);
  const siteCreate = (await repo.listAudit()).find(
    (e) => e.entityType === "site" && e.action === "create",
  )!;
  expect(siteCreate.entityId).toBe(s.id);
});

// ---- Slack webhook URL (issue #10) ----

test("createProject stores a valid https slack webhook url", async () => {
  const c = await repo.createProject(
    projectInput({ slackWebhookUrl: "https://hooks.slack.com/services/T/B/x" }),
    actor,
  );
  expect(c.slackWebhookUrl).toBe("https://hooks.slack.com/services/T/B/x");
});

test("createProject defaults slackWebhookUrl to null and rejects non-https", async () => {
  const c = await repo.createProject({ name: "Acme" }, actor);
  expect(c.slackWebhookUrl).toBeNull();
  const err = await repo
    .createProject(projectInput({ slackWebhookUrl: "http://insecure.test/x" }), actor)
    .catch((e) => e);
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).field).toBe("slackWebhookUrl");
});

test("createProject treats an empty slack webhook url as unset (null)", async () => {
  const c = await repo.createProject(projectInput({ slackWebhookUrl: "" }), actor);
  expect(c.slackWebhookUrl).toBeNull();
});

test("updateProject can set and clear the slack webhook url", async () => {
  const c = await repo.createProject(projectInput({ slackWebhookUrl: null }), actor);
  const set = await repo.updateProject(
    c.id,
    { slackWebhookUrl: "https://hooks.slack.com/x" },
    actor,
  );
  expect(set!.slackWebhookUrl).toBe("https://hooks.slack.com/x");
  const cleared = await repo.updateProject(c.id, { slackWebhookUrl: null }, actor);
  expect(cleared!.slackWebhookUrl).toBeNull();
});
