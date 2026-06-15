/**
 * Cross-cutting regression lock for #16 manager scoping: every authenticated read
 * surface (projects, sites, checks, runs, uichecks, groups, incidents, dashboard)
 * must hide resources outside a manager's portfolio — and must NOT restrict an
 * admin or an unassigned ("plain") viewer. One app wiring all the route modules,
 * one manager, one foreign project.
 */
import { beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  applyIncidentForRun,
  createConfigRepo,
  InMemoryConfigStore,
  type ConfigRepo,
} from "@naikan/config-repo";
import { createAuth, type Auth } from "./service.ts";
import { InMemorySessionStore, InMemoryUserStore } from "./in-memory-stores.ts";
import { createConfigApp } from "../config/routes.ts";
import { createHeartbeatApp } from "../heartbeat/routes.ts";
import { createUICheckApp } from "../uicheck/routes.ts";
import { createGroupApp } from "../group/routes.ts";
import { createIncidentApp } from "../incident/routes.ts";
import { createDashboardApp } from "../dashboard/routes.ts";

let app: Hono;
let auth: Auth;
let repo: ConfigRepo;

// One foreign project (B) the manager does NOT own, fully populated.
let foreign: {
  projectId: string;
  siteId: string;
  checkId: string;
  uicheckId: string;
  groupId: string;
};
// One project (A) the manager owns.
let mineProjectId: string;
let mineCheckId: string;

const noopStore = {
  get: async () => Buffer.from(""),
  put: async () => {},
  copy: async () => {},
  presignGet: async () => "",
};

beforeEach(async () => {
  auth = createAuth({ users: new InMemoryUserStore(), sessions: new InMemorySessionStore() });
  await auth.createUser({ email: "admin@example.com", password: "adminpass", role: "admin" });
  await auth.createUser({ email: "plain@example.com", password: "plainpass", role: "viewer" });
  await auth.createUser({ email: "mara@example.com", password: "marapass", role: "viewer" });
  const mara = (await auth.listUsers()).find((u) => u.email === "mara@example.com")!;

  repo = createConfigRepo(new InMemoryConfigStore());

  // Mara's own project (A) with a check.
  const a = await repo.createProject({ name: "Mara's", assignedManagerId: mara.id }, { id: null });
  mineProjectId = a.id;
  const aSite = await repo.createSite({ projectId: a.id, baseUrl: "https://mine.test" }, { id: null });
  const aCheck = await repo.createCheck({ siteId: aSite.id, path: "/", alertAfterNFails: 1 }, { id: null });
  mineCheckId = aCheck.id;

  // Foreign project (B), unassigned, fully populated incl. an open incident.
  const b = await repo.createProject({ name: "Someone else's" }, { id: null });
  const bSite = await repo.createSite({ projectId: b.id, baseUrl: "https://other.test" }, { id: null });
  const bCheck = await repo.createCheck({ siteId: bSite.id, path: "/health", alertAfterNFails: 1 }, { id: null });
  const bUICheck = await repo.createUICheck({ siteId: bSite.id, path: "/" }, { id: null });
  const bGroup = await repo.createGroup({ projectId: b.id, name: "prod" }, { id: null });
  await repo.recordRun({
    checkId: bCheck.id,
    checkType: "heartbeat",
    startedAt: new Date(),
    finishedAt: new Date(),
    status: "fail",
    latencyMs: 1,
    error: "down",
  });
  await applyIncidentForRun({ repo, checkId: bCheck.id });
  foreign = { projectId: b.id, siteId: bSite.id, checkId: bCheck.id, uicheckId: bUICheck.id, groupId: bGroup.id };

  app = new Hono();
  app.route("/", createConfigApp({ auth, repo }));
  app.route("/", createHeartbeatApp({ auth, repo }));
  app.route("/", createUICheckApp({ auth, repo, enqueueUIRun: async () => {}, store: noopStore }));
  app.route("/", createGroupApp({ auth, repo }));
  app.route("/", createIncidentApp({ auth, repo }));
  app.route("/", createDashboardApp({ auth, repo }));
});

async function cookieFor(email: string, password: string): Promise<string> {
  const result = await auth.login(email, password);
  return `cm_session=${result!.session.id}`;
}

/** Every guarded read path, parameterised against the foreign project (B). */
function foreignReadPaths(): string[] {
  return [
    `/api/projects/${foreign.projectId}`,
    `/api/projects/${foreign.projectId}/sites`,
    `/api/sites/${foreign.siteId}`,
    `/api/sites/${foreign.siteId}/checks`,
    `/api/checks/${foreign.checkId}`,
    `/api/checks/${foreign.checkId}/runs`,
    `/api/sites/${foreign.siteId}/uichecks`,
    `/api/uichecks/${foreign.uicheckId}`,
    `/api/uichecks/${foreign.uicheckId}/runs`,
    `/api/projects/${foreign.projectId}/groups`,
    `/api/groups/${foreign.groupId}`,
    `/api/projects/${foreign.projectId}/incidents`,
    `/api/projects/${foreign.projectId}/overview`,
  ];
}

test("a manager gets 404 on every read surface of a project outside their portfolio", async () => {
  const cookie = await cookieFor("mara@example.com", "marapass");
  for (const path of foreignReadPaths()) {
    const res = await app.request(path, { headers: { cookie } });
    expect(res.status, `expected 404 for ${path}`).toBe(404);
  }
});

test("a manager still reads their own project's resources", async () => {
  const cookie = await cookieFor("mara@example.com", "marapass");
  expect((await app.request(`/api/projects/${mineProjectId}`, { headers: { cookie } })).status).toBe(200);
  expect((await app.request(`/api/checks/${mineCheckId}`, { headers: { cookie } })).status).toBe(200);
  expect((await app.request(`/api/projects/${mineProjectId}/overview`, { headers: { cookie } })).status).toBe(200);
});

test("scoping does not restrict an unassigned plain viewer (sees the foreign project)", async () => {
  const cookie = await cookieFor("plain@example.com", "plainpass");
  for (const path of foreignReadPaths()) {
    const res = await app.request(path, { headers: { cookie } });
    expect(res.status, `expected 200 for plain viewer on ${path}`).toBe(200);
  }
});

test("scoping does not restrict an admin (sees the foreign project)", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  for (const path of foreignReadPaths()) {
    const res = await app.request(path, { headers: { cookie } });
    expect(res.status, `expected 200 for admin on ${path}`).toBe(200);
  }
});
