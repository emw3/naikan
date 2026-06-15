import { beforeEach, expect, test } from "bun:test";
import { createConfigRepo, InMemoryConfigStore, type ConfigRepo } from "@naikan/config-repo";
import { artifactKeys, TOMBSTONE_REF } from "@naikan/baseline-store";
import { createUICheckApp } from "./routes.ts";
import { createAuth, type Auth } from "../auth/service.ts";
import { InMemorySessionStore, InMemoryUserStore } from "../auth/in-memory-stores.ts";

let app: ReturnType<typeof createUICheckApp>;
let auth: Auth;
let repo: ConfigRepo;
let siteId: string;
let projectId: string;
let enqueued: string[];
let storeObjects: Record<string, Buffer>;

beforeEach(async () => {
  auth = createAuth({ users: new InMemoryUserStore(), sessions: new InMemorySessionStore() });
  await auth.createUser({ email: "admin@example.com", password: "adminpass", role: "admin" });
  await auth.createUser({ email: "viewer@example.com", password: "viewerpass", role: "viewer" });
  repo = createConfigRepo(new InMemoryConfigStore());
  const project = await repo.createProject({ name: "Acme" }, { id: null });
  projectId = project.id;
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, { id: null });
  siteId = site.id;

  enqueued = [];
  storeObjects = {};
  app = createUICheckApp({
    auth,
    repo,
    enqueueUIRun: (checkId) => {
      enqueued.push(checkId);
      return Promise.resolve();
    },
    store: {
      get: (key) =>
        storeObjects[key] ? Promise.resolve(storeObjects[key]) : Promise.reject(new Error("missing")),
      put: (key, body) => {
        storeObjects[key] = body;
        return Promise.resolve();
      },
      copy: (src, dst) => {
        const body = storeObjects[src];
        if (!body) return Promise.reject(new Error("missing source"));
        storeObjects[dst] = Buffer.from(body);
        return Promise.resolve();
      },
      presignGet: (key, ttl) => Promise.resolve(`https://signed.example/${key}?ttl=${ttl}`),
    },
  });
});

async function cookieFor(email: string, password: string): Promise<string> {
  const result = await auth.login(email, password);
  return `cm_session=${result!.session.id}`;
}

const JSON_HEADERS = { "content-type": "application/json" };

async function createUICheck(cookie: string, over: Record<string, unknown> = {}) {
  return app.request(`/api/sites/${siteId}/uichecks`, {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ path: "/pricing", ...over }),
  });
}

// ---- auth / role gating ----

test("listing UI checks requires a session (401)", async () => {
  expect((await app.request(`/api/sites/${siteId}/uichecks`)).status).toBe(401);
});

test("viewer can list UI checks (200) but cannot create one (403)", async () => {
  const cookie = await cookieFor("viewer@example.com", "viewerpass");
  expect((await app.request(`/api/sites/${siteId}/uichecks`, { headers: { cookie } })).status).toBe(200);
  expect((await createUICheck(cookie)).status).toBe(403);
});

// ---- discovery: flat list of all UI checks (regression-judge agent enumeration) ----

test("the discovery list requires a session (401)", async () => {
  expect((await app.request("/api/uichecks")).status).toBe(401);
});

test("discovery lists every UI check across sites for an admin/unassigned viewer", async () => {
  const admin = await cookieFor("admin@example.com", "adminpass");
  await createUICheck(admin); // /pricing under Acme
  const other = await repo.createProject({ name: "Globex" }, { id: null });
  const otherSite = await repo.createSite({ projectId: other.id, baseUrl: "https://globex.test" }, { id: null });
  await repo.createUICheck({ siteId: otherSite.id, path: "/login" }, { id: null });

  const res = await app.request("/api/uichecks", { headers: { cookie: admin } });
  expect(res.status).toBe(200);
  const { checks } = (await res.json()) as { checks: Array<{ path: string }> };
  expect(checks.map((c) => c.path).sort()).toEqual(["/login", "/pricing"]);
});

test("discovery is manager-scoped: a manager sees only their assigned project's checks", async () => {
  await auth.createUser({ email: "mara@example.com", password: "marapass", role: "viewer" });
  const mara = (await auth.listUsers()).find((u) => u.email === "mara@example.com")!;
  // Acme is unassigned to Mara; Globex is hers.
  await repo.createUICheck({ siteId, path: "/pricing" }, { id: null });
  const mine = await repo.createProject({ name: "Globex", assignedManagerId: mara.id }, { id: null });
  const mySite = await repo.createSite({ projectId: mine.id, baseUrl: "https://globex.test" }, { id: null });
  await repo.createUICheck({ siteId: mySite.id, path: "/login" }, { id: null });

  const cookie = await cookieFor("mara@example.com", "marapass");
  const res = await app.request("/api/uichecks", { headers: { cookie } });
  expect(res.status).toBe(200);
  const { checks } = (await res.json()) as { checks: Array<{ path: string }> };
  expect(checks.map((c) => c.path)).toEqual(["/login"]);
});

// ---- CRUD ----

test("admin creates, reads, updates, and deletes a UI check", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");

  const created = await createUICheck(cookie);
  expect(created.status).toBe(201);
  const { check } = (await created.json()) as { check: { id: string; path: string; viewports: string[] } };
  expect(check.path).toBe("/pricing");
  expect(check.viewports).toEqual(["mobile", "tablet", "desktop"]); // defaults

  expect((await app.request(`/api/uichecks/${check.id}`, { headers: { cookie } })).status).toBe(200);

  const patched = await app.request(`/api/uichecks/${check.id}`, {
    method: "PATCH",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ viewports: ["desktop"] }),
  });
  expect(patched.status).toBe(200);
  expect(((await patched.json()) as { check: { viewports: string[] } }).check.viewports).toEqual(["desktop"]);

  const del = await app.request(`/api/uichecks/${check.id}`, { method: "DELETE", headers: { cookie } });
  expect(del.status).toBe(204);
  expect((await app.request(`/api/uichecks/${check.id}`, { headers: { cookie } })).status).toBe(404);
});

test("creating a UI check under an unknown site returns 404", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const res = await app.request("/api/sites/nope/uichecks", {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ path: "/x" }),
  });
  expect(res.status).toBe(404);
});

test("creating a UI check with a bad path returns 400 with the field", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const res = await createUICheck(cookie, { path: "pricing" });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { field: string }).field).toBe("path");
});

// ---- run-now: ENQUEUES a worker job, does NOT run synchronously ----

test("run-now enqueues a worker job and returns 202 without recording a run", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const { check } = (await (await createUICheck(cookie)).json()) as { check: { id: string } };

  const ran = await app.request(`/api/uichecks/${check.id}/run`, { method: "POST", headers: { cookie } });
  expect(ran.status).toBe(202);
  expect(((await ran.json()) as { enqueued: boolean }).enqueued).toBe(true);

  // The job was handed to the queue, NOT executed inline (no CheckRun yet).
  expect(enqueued).toEqual([check.id]);
  expect(await repo.listRuns(check.id)).toHaveLength(0);
});

test("run-now on an unknown UI check returns 404 and enqueues nothing", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const res = await app.request("/api/uichecks/nope/run", { method: "POST", headers: { cookie } });
  expect(res.status).toBe(404);
  expect(enqueued).toHaveLength(0);
});

test("viewer cannot run a UI check (403)", async () => {
  const admin = await cookieFor("admin@example.com", "adminpass");
  const { check } = (await (await createUICheck(admin)).json()) as { check: { id: string } };
  const viewer = await cookieFor("viewer@example.com", "viewerpass");
  const res = await app.request(`/api/uichecks/${check.id}/run`, { method: "POST", headers: { cookie: viewer } });
  expect(res.status).toBe(403);
});

// ---- runs + screenshots (presigned from the manifest) ----

test("run detail returns presigned screenshot URLs read from the manifest", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const { check } = (await (await createUICheck(cookie)).json()) as { check: { id: string } };

  // Simulate a completed worker run: a manifest object + a uicheck CheckRun pointing at it.
  const runId = "run-1";
  const manifestKey = artifactKeys.runManifest(projectId, check.id, runId);
  const screenshots = {
    mobile: artifactKeys.runScreenshot(projectId, check.id, runId, "mobile"),
    desktop: artifactKeys.runScreenshot(projectId, check.id, runId, "desktop"),
  };
  storeObjects[manifestKey] = Buffer.from(
    JSON.stringify({ runId, viewports: ["mobile", "desktop"], screenshots }),
  );
  const run = await repo.recordRun({
    checkId: check.id,
    checkType: "uicheck",
    startedAt: new Date(1000),
    finishedAt: new Date(1200),
    status: "pass",
    latencyMs: 200,
    error: null,
    artifactsRef: manifestKey,
  });

  const res = await app.request(`/api/uichecks/${check.id}/runs/${run.id}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { run: { id: string }; screenshots: Record<string, string> };
  expect(body.run.id).toBe(run.id);
  expect(body.screenshots.mobile).toContain(screenshots.mobile);
  expect(body.screenshots.desktop).toContain(screenshots.desktop);
});

test("run detail degrades to empty screenshots when the manifest is unreadable", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const { check } = (await (await createUICheck(cookie)).json()) as { check: { id: string } };
  // A run whose manifest object is absent from the store (e.g. reaped) must not 500.
  const run = await repo.recordRun({
    checkId: check.id,
    checkType: "uicheck",
    startedAt: new Date(1000),
    finishedAt: new Date(1100),
    status: "pass",
    latencyMs: 100,
    error: null,
    artifactsRef: artifactKeys.runManifest(projectId, check.id, "gone"),
  });

  const res = await app.request(`/api/uichecks/${check.id}/runs/${run.id}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { run: { id: string }; screenshots: Record<string, string> };
  expect(body.run.id).toBe(run.id);
  expect(body.screenshots).toEqual({});
});

test("run detail flags a tombstoned run as expired without touching the store (#17)", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const { check } = (await (await createUICheck(cookie)).json()) as { check: { id: string } };
  const run = await repo.recordRun({
    checkId: check.id,
    checkType: "uicheck",
    startedAt: new Date(1000),
    finishedAt: new Date(1100),
    status: "pass",
    latencyMs: 100,
    error: null,
    artifactsRef: TOMBSTONE_REF, // reaper deleted the artifacts and tombstoned the run
  });

  const res = await app.request(`/api/uichecks/${check.id}/runs/${run.id}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { expired: boolean; screenshots: Record<string, string> };
  // Explicit "expired" flag (distinct from a merely-empty/corrupt manifest) drives
  // the dashboard's "artifacts expired" placeholder.
  expect(body.expired).toBe(true);
  expect(body.screenshots).toEqual({});
});

test("run detail reports expired=false for a run with live artifacts (#17)", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const { check } = (await (await createUICheck(cookie)).json()) as { check: { id: string } };
  const runId = "live-1";
  const manifestKey = artifactKeys.runManifest(projectId, check.id, runId);
  storeObjects[manifestKey] = Buffer.from(JSON.stringify({ runId, viewports: [], screenshots: {} }));
  const run = await repo.recordRun({
    checkId: check.id,
    checkType: "uicheck",
    startedAt: new Date(1000),
    finishedAt: new Date(1100),
    status: "pass",
    latencyMs: 100,
    error: null,
    artifactsRef: manifestKey,
  });

  const res = await app.request(`/api/uichecks/${check.id}/runs/${run.id}`, { headers: { cookie } });
  const body = (await res.json()) as { expired: boolean };
  expect(body.expired).toBe(false);
});

test("run detail returns per-viewport diff pct + presigned diff URLs from the manifest", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const { check } = (await (await createUICheck(cookie)).json()) as { check: { id: string } };

  const runId = "run-d";
  const manifestKey = artifactKeys.runManifest(projectId, check.id, runId);
  const shotKey = artifactKeys.runScreenshot(projectId, check.id, runId, "mobile");
  const diffKey = artifactKeys.runDiff(projectId, check.id, runId, "mobile");
  storeObjects[manifestKey] = Buffer.from(
    JSON.stringify({
      runId,
      viewports: ["mobile"],
      screenshots: { mobile: shotKey },
      diffs: { mobile: { pct: 0.0234, key: diffKey } },
    }),
  );
  const run = await repo.recordRun({
    checkId: check.id,
    checkType: "uicheck",
    startedAt: new Date(1000),
    finishedAt: new Date(1200),
    status: "fail",
    latencyMs: 200,
    error: null,
    artifactsRef: manifestKey,
  });

  const res = await app.request(`/api/uichecks/${check.id}/runs/${run.id}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    diffs: Record<string, { pct: number; url: string | null }>;
  };
  expect(body.diffs.mobile!.pct).toBe(0.0234);
  expect(body.diffs.mobile!.url).toContain(diffKey);
});

test("run detail returns per-viewport judged signals verbatim from the manifest (#13)", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const { check } = (await (await createUICheck(cookie)).json()) as { check: { id: string } };

  const runId = "run-s";
  const manifestKey = artifactKeys.runManifest(projectId, check.id, runId);
  const shotKey = artifactKeys.runScreenshot(projectId, check.id, runId, "mobile");
  const signals = [
    { kind: "load", pass: true, severity: "critical", detail: "HTTP 200" },
    { kind: "console", pass: false, severity: "warning", detail: "1 console error: ReferenceError: x is not defined" },
    { kind: "selector", pass: false, severity: "warning", detail: "missing: .cta" },
    { kind: "perf", pass: true, severity: "warning", detail: "LCP 800ms, 1KB, 4 requests" },
  ];
  storeObjects[manifestKey] = Buffer.from(
    JSON.stringify({ runId, viewports: ["mobile"], screenshots: { mobile: shotKey }, signals: { mobile: signals } }),
  );
  const run = await repo.recordRun({
    checkId: check.id,
    checkType: "uicheck",
    startedAt: new Date(1000),
    finishedAt: new Date(1200),
    status: "fail",
    latencyMs: 200,
    error: null,
    artifactsRef: manifestKey,
  });

  const res = await app.request(`/api/uichecks/${check.id}/runs/${run.id}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    signals: Record<string, Array<{ kind: string; pass: boolean; severity: string; detail: string }>>;
  };
  expect(body.signals.mobile).toEqual(signals);
});

test("run detail returns presigned baseline URLs when the check has a baseline", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const { check } = (await (await createUICheck(cookie)).json()) as { check: { id: string } };

  // Seed an approved baseline (manifest + one buffer) and point the check at it.
  const baseMobile = artifactKeys.baseline(projectId, check.id, "mobile");
  const baseManifestKey = artifactKeys.baselineManifest(projectId, check.id);
  storeObjects[baseMobile] = Buffer.from("baseline-mobile");
  storeObjects[baseManifestKey] = Buffer.from(
    JSON.stringify({ promotedFromRunId: "r0", screenshots: { mobile: baseMobile } }),
  );
  await repo.promoteUICheckBaseline(check.id, { baselineImageRef: baseManifestKey, runId: "r0" }, { id: null });

  const runId = "run-b";
  const manifestKey = artifactKeys.runManifest(projectId, check.id, runId);
  const shotKey = artifactKeys.runScreenshot(projectId, check.id, runId, "mobile");
  storeObjects[manifestKey] = Buffer.from(
    JSON.stringify({ runId, viewports: ["mobile"], screenshots: { mobile: shotKey } }),
  );
  const run = await repo.recordRun({
    checkId: check.id,
    checkType: "uicheck",
    startedAt: new Date(1000),
    finishedAt: new Date(1200),
    status: "pass",
    latencyMs: 200,
    error: null,
    artifactsRef: manifestKey,
  });

  const res = await app.request(`/api/uichecks/${check.id}/runs/${run.id}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { baseline: Record<string, string> };
  expect(body.baseline.mobile).toContain(baseMobile);
});

test("run detail returns an empty baseline map when the check has none", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const { check } = (await (await createUICheck(cookie)).json()) as { check: { id: string } };
  const run = await repo.recordRun({
    checkId: check.id,
    checkType: "uicheck",
    startedAt: new Date(1000),
    finishedAt: new Date(1100),
    status: "pass",
    latencyMs: 100,
    error: null,
    artifactsRef: artifactKeys.runManifest(projectId, check.id, "run-x"),
  });
  const res = await app.request(`/api/uichecks/${check.id}/runs/${run.id}`, { headers: { cookie } });
  const body = (await res.json()) as { baseline: Record<string, string> };
  expect(body.baseline).toEqual({});
});

// ---- promote to baseline (#12) ----

async function setupRunWithManifest(checkId: string, runId: string) {
  const screenshots = {
    mobile: artifactKeys.runScreenshot(projectId, checkId, runId, "mobile"),
    desktop: artifactKeys.runScreenshot(projectId, checkId, runId, "desktop"),
  };
  storeObjects[screenshots.mobile] = Buffer.from(`png-mobile-${runId}`);
  storeObjects[screenshots.desktop] = Buffer.from(`png-desktop-${runId}`);
  const manifestKey = artifactKeys.runManifest(projectId, checkId, runId);
  storeObjects[manifestKey] = Buffer.from(
    JSON.stringify({ runId, viewports: ["mobile", "desktop"], screenshots }),
  );
  const run = await repo.recordRun({
    checkId,
    checkType: "uicheck",
    startedAt: new Date(1000),
    finishedAt: new Date(1200),
    status: "pass",
    latencyMs: 200,
    error: null,
    artifactsRef: manifestKey,
  });
  return { run, screenshots };
}

test("admin promotes a run: copies screenshots into the baseline subtree and points the check at a baseline manifest", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const { check } = (await (await createUICheck(cookie)).json()) as { check: { id: string } };
  const { run } = await setupRunWithManifest(check.id, "run-1");

  const res = await app.request(`/api/uichecks/${check.id}/runs/${run.id}/promote`, {
    method: "POST",
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  const { check: updated } = (await res.json()) as { check: { baselineImageRef: string } };

  // The check now points at a baseline manifest in the baseline subtree.
  const baselineManifestKey = artifactKeys.baselineManifest(projectId, check.id);
  expect(updated.baselineImageRef).toBe(baselineManifestKey);

  // Screenshots were copied (bytes duplicated) into the baseline subtree, not re-pointed at run keys.
  const baseMobile = artifactKeys.baseline(projectId, check.id, "mobile");
  const baseDesktop = artifactKeys.baseline(projectId, check.id, "desktop");
  expect(storeObjects[baseMobile]?.toString()).toBe("png-mobile-run-1");
  expect(storeObjects[baseDesktop]?.toString()).toBe("png-desktop-run-1");

  // The baseline manifest records which run was promoted + the per-viewport baseline keys.
  const baselineManifest = JSON.parse(storeObjects[baselineManifestKey]!.toString()) as {
    promotedFromRunId: string;
    screenshots: Record<string, string>;
  };
  expect(baselineManifest.promotedFromRunId).toBe("run-1");
  expect(baselineManifest.screenshots).toEqual({ mobile: baseMobile, desktop: baseDesktop });
});

test("promote writes an audit row naming the actor and the promoted run", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const { check } = (await (await createUICheck(cookie)).json()) as { check: { id: string } };
  const { run } = await setupRunWithManifest(check.id, "run-1");

  await app.request(`/api/uichecks/${check.id}/runs/${run.id}/promote`, {
    method: "POST",
    headers: { cookie },
  });

  const row = (await repo.listAudit()).find(
    (e) => e.entityType === "uicheck" && e.action === "update" && e.entityId === check.id,
  )!;
  expect(row.diff.after).toMatchObject({ promotedFromRunId: "run-1" });
});

test("viewer cannot promote a run to baseline (403)", async () => {
  const admin = await cookieFor("admin@example.com", "adminpass");
  const { check } = (await (await createUICheck(admin)).json()) as { check: { id: string } };
  const { run } = await setupRunWithManifest(check.id, "run-1");
  const viewer = await cookieFor("viewer@example.com", "viewerpass");
  const res = await app.request(`/api/uichecks/${check.id}/runs/${run.id}/promote`, {
    method: "POST",
    headers: { cookie: viewer },
  });
  expect(res.status).toBe(403);
});

test("promoting an unknown run returns 404 and leaves the check's baseline unset", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const { check } = (await (await createUICheck(cookie)).json()) as { check: { id: string } };
  const res = await app.request(`/api/uichecks/${check.id}/runs/nope/promote`, {
    method: "POST",
    headers: { cookie },
  });
  expect(res.status).toBe(404);
  expect((await repo.getUICheck(check.id))?.baselineImageRef).toBeNull();
});

test("listing runs returns recorded uicheck runs", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const { check } = (await (await createUICheck(cookie)).json()) as { check: { id: string } };
  await repo.recordRun({
    checkId: check.id,
    checkType: "uicheck",
    startedAt: new Date(1000),
    finishedAt: new Date(1100),
    status: "pass",
    latencyMs: 100,
    error: null,
    artifactsRef: artifactKeys.runManifest(projectId, check.id, "run-1"),
  });
  const res = await app.request(`/api/uichecks/${check.id}/runs`, { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { runs: unknown[] }).runs).toHaveLength(1);
});
