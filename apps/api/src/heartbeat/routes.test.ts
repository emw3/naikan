import { beforeEach, expect, test } from "bun:test";
import { createConfigRepo, InMemoryConfigStore, type ConfigRepo } from "@naikan/config-repo";
import type { CheckRunResult } from "@naikan/heartbeat-runner";
import { createHeartbeatApp } from "./routes.ts";
import { createAuth, type Auth } from "../auth/service.ts";
import { InMemorySessionStore, InMemoryUserStore } from "../auth/in-memory-stores.ts";

let app: ReturnType<typeof createHeartbeatApp>;
let auth: Auth;
let repo: ConfigRepo;
let siteId: string;
let runCalls: Array<{ baseUrl: string; path: string }>;
let stubResult: CheckRunResult;

beforeEach(async () => {
  auth = createAuth({ users: new InMemoryUserStore(), sessions: new InMemorySessionStore() });
  await auth.createUser({ email: "admin@example.com", password: "adminpass", role: "admin" });
  await auth.createUser({ email: "viewer@example.com", password: "viewerpass", role: "viewer" });
  repo = createConfigRepo(new InMemoryConfigStore());
  const project = await repo.createProject({ name: "Acme" }, { id: null });
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, { id: null });
  siteId = site.id;

  runCalls = [];
  stubResult = {
    status: "pass",
    startedAt: new Date(1000),
    finishedAt: new Date(1100),
    latencyMs: 100,
    error: null,
  };
  app = createHeartbeatApp({
    auth,
    repo,
    runCheck: (baseUrl, check) => {
      runCalls.push({ baseUrl, path: check.path });
      return Promise.resolve(stubResult);
    },
  });
});

async function cookieFor(email: string, password: string): Promise<string> {
  const result = await auth.login(email, password);
  return `cm_session=${result!.session.id}`;
}

const JSON_HEADERS = { "content-type": "application/json" };

function checkBody(over: Record<string, unknown> = {}) {
  return JSON.stringify({ path: "/health", certCheck: true, dnsCheck: true, ...over });
}

async function createCheck(cookie: string, over: Record<string, unknown> = {}) {
  const res = await app.request(`/api/sites/${siteId}/checks`, {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: checkBody(over),
  });
  return res;
}

// ---- auth / role gating ----

test("listing checks requires a session (401)", async () => {
  expect((await app.request(`/api/sites/${siteId}/checks`)).status).toBe(401);
});

test("viewer can list checks (200) but cannot create one (403)", async () => {
  const cookie = await cookieFor("viewer@example.com", "viewerpass");
  expect((await app.request(`/api/sites/${siteId}/checks`, { headers: { cookie } })).status).toBe(200);
  expect((await createCheck(cookie)).status).toBe(403);
});

// ---- CRUD ----

test("admin creates, reads, updates, and deletes a check", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");

  const created = await createCheck(cookie);
  expect(created.status).toBe(201);
  const { check } = (await created.json()) as { check: { id: string; path: string } };
  expect(check.path).toBe("/health");

  expect((await app.request(`/api/checks/${check.id}`, { headers: { cookie } })).status).toBe(200);

  const patched = await app.request(`/api/checks/${check.id}`, {
    method: "PATCH",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ path: "/status" }),
  });
  expect(patched.status).toBe(200);
  expect(((await patched.json()) as { check: { path: string } }).check.path).toBe("/status");

  const del = await app.request(`/api/checks/${check.id}`, { method: "DELETE", headers: { cookie } });
  expect(del.status).toBe(204);
  expect((await app.request(`/api/checks/${check.id}`, { headers: { cookie } })).status).toBe(404);
});

test("creating a check under an unknown site returns 404", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const res = await app.request("/api/sites/nope/checks", {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: checkBody(),
  });
  expect(res.status).toBe(404);
});

test("creating a check with a bad path returns 400 with the field", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const res = await createCheck(cookie, { path: "health" });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { field: string }).field).toBe("path");
});

// ---- CheckGroup assignment (issue #08): groupId pass-through + cross-project guard ----

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

// ---- run-now (the end-to-end integration criterion) ----

test("create check via API → run-now → CheckRun row written", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const { check } = (await (await createCheck(cookie)).json()) as { check: { id: string } };

  const ran = await app.request(`/api/checks/${check.id}/run`, { method: "POST", headers: { cookie } });
  expect(ran.status).toBe(200);
  const { run } = (await ran.json()) as { run: { id: string; status: string; latencyMs: number } };
  expect(run.status).toBe("pass");
  expect(run.latencyMs).toBe(100);

  // The runner was invoked with the site's base URL + the check's path.
  expect(runCalls).toEqual([{ baseUrl: "https://acme.test", path: "/health" }]);

  // A CheckRun row was persisted for the check.
  const runs = await repo.listRuns(check.id);
  expect(runs).toHaveLength(1);
  expect(runs[0]!.id).toBe(run.id);
  expect(runs[0]!.checkType).toBe("heartbeat");
});

test("run-now persists a failing result with the error", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const { check } = (await (await createCheck(cookie)).json()) as { check: { id: string } };
  stubResult = { ...stubResult, status: "fail", error: "HTTP 500" };

  const ran = await app.request(`/api/checks/${check.id}/run`, { method: "POST", headers: { cookie } });
  const { run } = (await ran.json()) as { run: { status: string; error: string | null } };
  expect(run.status).toBe("fail");
  expect(run.error).toBe("HTTP 500");
});

test("run-now on an unknown check returns 404", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const res = await app.request("/api/checks/nope/run", { method: "POST", headers: { cookie } });
  expect(res.status).toBe(404);
});

test("viewer cannot run a check (403)", async () => {
  const admin = await cookieFor("admin@example.com", "adminpass");
  const { check } = (await (await createCheck(admin)).json()) as { check: { id: string } };
  const viewer = await cookieFor("viewer@example.com", "viewerpass");
  const res = await app.request(`/api/checks/${check.id}/run`, { method: "POST", headers: { cookie: viewer } });
  expect(res.status).toBe(403);
});

test("listing runs returns recorded runs newest first", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const { check } = (await (await createCheck(cookie)).json()) as { check: { id: string } };
  await app.request(`/api/checks/${check.id}/run`, { method: "POST", headers: { cookie } });
  await app.request(`/api/checks/${check.id}/run`, { method: "POST", headers: { cookie } });

  const res = await app.request(`/api/checks/${check.id}/runs`, { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { runs: unknown[] }).runs).toHaveLength(2);
});

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
