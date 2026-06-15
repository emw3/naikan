import { beforeEach, expect, test } from "bun:test";
import {
  applyIncidentForRun,
  applyUIIncidentForRun,
  createConfigRepo,
  InMemoryConfigStore,
  type ConfigRepo,
} from "@naikan/config-repo";
import { createDashboardApp } from "./routes.ts";
import { createAuth, type Auth } from "../auth/service.ts";
import { InMemorySessionStore, InMemoryUserStore } from "../auth/in-memory-stores.ts";

// A fixed "now" so the 24h window + incident durations are deterministic.
const NOW_S = 1_000_000;
const at = (seconds: number): Date => new Date(seconds * 1000);
const now = (): Date => at(NOW_S);

let app: ReturnType<typeof createDashboardApp>;
let auth: Auth;
let repo: ConfigRepo;
let projectId: string;
let siteId: string;
let hbId: string;
let uiId: string;

beforeEach(async () => {
  auth = createAuth({ users: new InMemoryUserStore(), sessions: new InMemorySessionStore() });
  await auth.createUser({ email: "viewer@example.com", password: "viewerpass", role: "viewer" });
  repo = createConfigRepo(new InMemoryConfigStore());
  const project = await repo.createProject({ name: "Acme" }, { id: null });
  projectId = project.id;
  const site = await repo.createSite({ projectId, baseUrl: "https://acme.test" }, { id: null });
  siteId = site.id;
  const hb = await repo.createCheck({ siteId, path: "/health", alertAfterNFails: 1 }, { id: null });
  hbId = hb.id;
  const ui = await repo.createUICheck({ siteId, path: "/" }, { id: null });
  uiId = ui.id;
  app = createDashboardApp({ auth, repo, now });
});

async function cookieFor(email: string, password: string): Promise<string> {
  const result = await auth.login(email, password);
  return `cm_session=${result!.session.id}`;
}

async function viewerCookie(): Promise<string> {
  return cookieFor("viewer@example.com", "viewerpass");
}

/** Record a heartbeat run + resolve incident transitions. */
async function hbRun(status: "pass" | "fail", seconds: number): Promise<void> {
  await repo.recordRun({
    checkId: hbId,
    checkType: "heartbeat",
    startedAt: at(seconds),
    finishedAt: at(seconds),
    status,
    latencyMs: 42,
    error: status === "fail" ? "down" : null,
  });
  await applyIncidentForRun({ repo, checkId: hbId });
}

/** Record a UI run + resolve UI incident transitions (critical signal = the predicate). */
async function uiRun(critical: boolean, seconds: number): Promise<void> {
  await repo.recordRun({
    checkId: uiId,
    checkType: "uicheck",
    startedAt: at(seconds),
    finishedAt: at(seconds),
    status: critical ? "fail" : "pass",
    latencyMs: 100,
    error: critical ? "load failed" : null,
    criticalFailed: critical,
  });
  await applyUIIncidentForRun({ repo, checkId: uiId });
}

// ---- auth ----

test("dashboard routes require a session (401)", async () => {
  expect((await app.request(`/api/projects/${projectId}/overview`)).status).toBe(401);
  expect((await app.request(`/api/checks/${hbId}/detail`)).status).toBe(401);
  expect((await app.request(`/api/uichecks/${uiId}/detail`)).status).toBe(401);
  expect((await app.request(`/api/incidents`)).status).toBe(401);
});

// ---- project overview ----

test("overview 404s for an unknown project", async () => {
  const cookie = await viewerCookie();
  expect((await app.request(`/api/projects/nope/overview`, { headers: { cookie } })).status).toBe(404);
});

test("overview lists each check with its last-24h tally, state, and open-incident count", async () => {
  await hbRun("pass", NOW_S - 600); // inside the window
  await hbRun("fail", NOW_S - 300); // inside the window → opens an incident (N=1)
  await uiRun(false, NOW_S - 200); // a passing UI run inside the window

  const cookie = await viewerCookie();
  const res = await app.request(`/api/projects/${projectId}/overview`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    openIncidentCount: number;
    checks: Array<{
      id: string;
      kind: string;
      host: string;
      path: string;
      state: string;
      last24h: { pass: number; fail: number; total: number };
      openIncident: boolean;
    }>;
  };

  expect(body.openIncidentCount).toBe(1);
  const hb = body.checks.find((x) => x.id === hbId)!;
  expect(hb).toMatchObject({ kind: "heartbeat", host: "acme.test", path: "/health", state: "incident", openIncident: true });
  expect(hb.last24h).toEqual({ pass: 1, fail: 1, total: 2 });
  const ui = body.checks.find((x) => x.id === uiId)!;
  expect(ui).toMatchObject({ kind: "uicheck", path: "/", state: "ok", openIncident: false });
  expect(ui.last24h).toEqual({ pass: 1, fail: 0, total: 1 });
});

test("overview excludes runs older than 24h from the tally", async () => {
  await hbRun("pass", NOW_S - 600); // inside
  await hbRun("pass", NOW_S - 2 * 86400); // 2 days ago → outside the window

  const cookie = await viewerCookie();
  const res = await app.request(`/api/projects/${projectId}/overview`, { headers: { cookie } });
  const body = (await res.json()) as { checks: Array<{ id: string; last24h: { total: number } }> };
  expect(body.checks.find((x) => x.id === hbId)!.last24h.total).toBe(1);
});

test("overview is manager-scoped: 404 for a project outside the portfolio", async () => {
  await auth.createUser({ email: "mara@example.com", password: "marapass", role: "viewer" });
  const mara = (await auth.listUsers()).find((u) => u.email === "mara@example.com")!;
  const mine = await repo.createProject({ name: "Mara's", assignedManagerId: mara.id }, { id: null });

  const cookie = await cookieFor("mara@example.com", "marapass");
  // Acme (the default project) is not assigned to Mara → hidden.
  expect((await app.request(`/api/projects/${projectId}/overview`, { headers: { cookie } })).status).toBe(404);
  expect((await app.request(`/api/projects/${mine.id}/overview`, { headers: { cookie } })).status).toBe(200);
});

// ---- heartbeat detail ----

test("heartbeat detail returns the 24h timeline, state, and recent incidents", async () => {
  await hbRun("pass", NOW_S - 600);
  await hbRun("fail", NOW_S - 300); // opens
  await hbRun("pass", NOW_S - 200);
  await hbRun("pass", NOW_S - 100); // 2 passes → closes the incident

  const cookie = await viewerCookie();
  const res = await app.request(`/api/checks/${hbId}/detail`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    host: string;
    state: string;
    last24h: { total: number };
    timeline: Array<{ status: string; latencyMs: number }>;
    recentIncidents: Array<{ closedAt: string | null }>;
  };
  expect(body.host).toBe("acme.test");
  expect(body.state).toBe("ok"); // last run passed, no open incident
  expect(body.timeline).toHaveLength(4);
  expect(body.timeline[0]!.latencyMs).toBe(42);
  expect(body.recentIncidents).toHaveLength(1);
  expect(body.recentIncidents[0]!.closedAt).toBeTruthy();
});

test("heartbeat detail 404s for an unknown check", async () => {
  const cookie = await viewerCookie();
  expect((await app.request(`/api/checks/nope/detail`, { headers: { cookie } })).status).toBe(404);
});

// ---- ui check detail ----

test("ui check detail reports state and recent incidents", async () => {
  await uiRun(true, NOW_S - 300); // critical fail → opens a UI incident immediately

  const cookie = await viewerCookie();
  const res = await app.request(`/api/uichecks/${uiId}/detail`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { host: string; state: string; recentIncidents: unknown[] };
  expect(body.host).toBe("acme.test");
  expect(body.state).toBe("incident");
  expect(body.recentIncidents).toHaveLength(1);
});

// ---- incidents view ----

test("incidents view filters by open/closed and reports duration", async () => {
  await hbRun("fail", NOW_S - 500); // opens at NOW-500
  const cookie = await viewerCookie();

  let res = await app.request(`/api/incidents`, { headers: { cookie } }); // defaults to open
  let body = (await res.json()) as {
    incidents: Array<{ checkLabel: string; checkType: string; open: boolean; durationMs: number; projectName: string }>;
  };
  expect(body.incidents).toHaveLength(1);
  expect(body.incidents[0]).toMatchObject({
    checkLabel: "acme.test/health",
    checkType: "heartbeat",
    open: true,
    projectName: "Acme",
  });
  expect(body.incidents[0]!.durationMs).toBe(500 * 1000); // (now - openedAt)

  // No closed incidents yet.
  res = await app.request(`/api/incidents?status=closed`, { headers: { cookie } });
  body = (await res.json()) as typeof body;
  expect(body.incidents).toHaveLength(0);

  // Recover → now appears under closed, not open.
  await hbRun("pass", NOW_S - 200);
  await hbRun("pass", NOW_S - 100);
  res = await app.request(`/api/incidents?status=closed`, { headers: { cookie } });
  body = (await res.json()) as typeof body;
  expect(body.incidents).toHaveLength(1);
  expect(body.incidents[0]!.open).toBe(false);

  res = await app.request(`/api/incidents`, { headers: { cookie } });
  body = (await res.json()) as typeof body;
  expect(body.incidents).toHaveLength(0);
});

test("incidents view is manager-scoped to the user's projects", async () => {
  await hbRun("fail", NOW_S - 500); // an open incident on Acme

  await auth.createUser({ email: "mara@example.com", password: "marapass", role: "viewer" });
  const mara = (await auth.listUsers()).find((u) => u.email === "mara@example.com")!;
  await repo.createProject({ name: "Mara's", assignedManagerId: mara.id }, { id: null });

  // Mara manages only her (incident-free) project → sees no incidents.
  const cookie = await cookieFor("mara@example.com", "marapass");
  const res = await app.request(`/api/incidents`, { headers: { cookie } });
  const body = (await res.json()) as { incidents: unknown[] };
  expect(body.incidents).toHaveLength(0);
});
