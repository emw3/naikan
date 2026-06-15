import { beforeEach, expect, test } from "bun:test";
import { applyIncidentForRun, createConfigRepo, InMemoryConfigStore, type ConfigRepo } from "@naikan/config-repo";
import { createIncidentApp } from "./routes.ts";
import { createAuth, type Auth } from "../auth/service.ts";
import { InMemorySessionStore, InMemoryUserStore } from "../auth/in-memory-stores.ts";

let app: ReturnType<typeof createIncidentApp>;
let auth: Auth;
let repo: ConfigRepo;
let projectId: string;
let checkId: string;
const at = (seconds: number): Date => new Date(seconds * 1000);

beforeEach(async () => {
  auth = createAuth({ users: new InMemoryUserStore(), sessions: new InMemorySessionStore() });
  await auth.createUser({ email: "viewer@example.com", password: "viewerpass", role: "viewer" });
  repo = createConfigRepo(new InMemoryConfigStore());
  const project = await repo.createProject({ name: "Acme" }, { id: null });
  projectId = project.id;
  const site = await repo.createSite({ projectId, baseUrl: "https://acme.test" }, { id: null });
  const check = await repo.createCheck({ siteId: site.id, path: "/health", alertAfterNFails: 1 }, { id: null });
  checkId = check.id;
  app = createIncidentApp({ auth, repo });
});

async function cookieFor(email: string, password: string): Promise<string> {
  const result = await auth.login(email, password);
  return `cm_session=${result!.session.id}`;
}

async function recordAndApply(status: "pass" | "fail", seconds: number): Promise<void> {
  await repo.recordRun({
    checkId,
    checkType: "heartbeat",
    startedAt: at(seconds),
    finishedAt: at(seconds),
    status,
    latencyMs: 0,
    error: status === "fail" ? "down" : null,
  });
  await applyIncidentForRun({ repo, checkId });
}

test("listing incidents requires a session (401)", async () => {
  expect((await app.request(`/api/projects/${projectId}/incidents`)).status).toBe(401);
});

test("unknown project returns 404", async () => {
  const cookie = await cookieFor("viewer@example.com", "viewerpass");
  expect((await app.request(`/api/projects/nope/incidents`, { headers: { cookie } })).status).toBe(404);
});

test("viewer sees open then closed incidents split out", async () => {
  const cookie = await cookieFor("viewer@example.com", "viewerpass");

  await recordAndApply("fail", 0); // N=1 → opens immediately
  let res = await app.request(`/api/projects/${projectId}/incidents`, { headers: { cookie } });
  expect(res.status).toBe(200);
  let body = (await res.json()) as { open: unknown[]; closed: unknown[] };
  expect(body.open).toHaveLength(1);
  expect(body.closed).toHaveLength(0);

  await recordAndApply("pass", 60);
  await recordAndApply("pass", 120); // 2 successes → closes
  res = await app.request(`/api/projects/${projectId}/incidents`, { headers: { cookie } });
  body = (await res.json()) as { open: unknown[]; closed: { closedAt: string }[] };
  expect(body.open).toHaveLength(0);
  expect(body.closed).toHaveLength(1);
  expect(body.closed[0]!.closedAt).toBeTruthy();
});
