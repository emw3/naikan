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
