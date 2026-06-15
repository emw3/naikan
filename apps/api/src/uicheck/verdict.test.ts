import { beforeEach, expect, test } from "bun:test";
import { createConfigRepo, InMemoryConfigStore, type ConfigRepo, type CheckRun } from "@naikan/config-repo";
import { createUICheckApp } from "./routes.ts";
import { createAuth, type Auth } from "../auth/service.ts";
import { InMemorySessionStore, InMemoryUserStore } from "../auth/in-memory-stores.ts";

const AGENT_TOKEN = "test-agent-token-abc123";
const JSON_HEADERS = { "content-type": "application/json" };

let auth: Auth;
let repo: ConfigRepo;
let app: ReturnType<typeof createUICheckApp>;
let checkId: string;
let run: CheckRun;

const fakeStore = {
  get: () => Promise.reject(new Error("missing")),
  put: () => Promise.resolve(),
  copy: () => Promise.resolve(),
  presignGet: (key: string, ttl: number) => Promise.resolve(`https://signed.example/${key}?ttl=${ttl}`),
};

function makeApp(over: { agentToken?: string } = { agentToken: AGENT_TOKEN }) {
  return createUICheckApp({ auth, repo, enqueueUIRun: () => Promise.resolve(), store: fakeStore, ...over });
}

beforeEach(async () => {
  auth = createAuth({ users: new InMemoryUserStore(), sessions: new InMemorySessionStore() });
  await auth.createUser({ email: "admin@example.com", password: "adminpass", role: "admin" });
  repo = createConfigRepo(new InMemoryConfigStore());
  const project = await repo.createProject({ name: "Acme" }, { id: null });
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, { id: null });
  const check = await repo.createUICheck({ siteId: site.id }, { id: null });
  checkId = check.id;
  run = await repo.recordRun({
    checkId: check.id,
    checkType: "uicheck",
    startedAt: new Date("2026-06-08T00:00:00Z"),
    finishedAt: new Date("2026-06-08T00:00:01Z"),
    status: "fail",
    latencyMs: 1200,
    criticalFailed: false,
  });
  app = makeApp();
});

const verdictUrl = () => `/api/uichecks/${checkId}/runs/${run.id}/verdict`;
const agentHeaders = { authorization: `Bearer ${AGENT_TOKEN}`, ...JSON_HEADERS };
const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ verdict: "real_regression", confidence: 0.9, reasoning: "Nav collapsed.", model: "claude-opus-4-8", ...over });

async function cookieFor(email: string, password: string): Promise<string> {
  const result = await auth.login(email, password);
  return `cm_session=${result!.session.id}`;
}

test("agent bearer token records a verdict (201) that then surfaces in run-detail", async () => {
  const res = await app.request(verdictUrl(), { method: "POST", headers: agentHeaders, body: body() });
  expect(res.status).toBe(201);
  const { verdict } = (await res.json()) as { verdict: { verdict: string; model: string } };
  expect(verdict.verdict).toBe("real_regression");
  expect(verdict.model).toBe("claude-opus-4-8");

  const detail = await app.request(`/api/uichecks/${checkId}/runs/${run.id}`, { headers: agentHeaders });
  const json = (await detail.json()) as { verdict: { verdict: string } | null };
  expect(json.verdict?.verdict).toBe("real_regression");
});

test("run-detail verdict is null before any verdict is recorded", async () => {
  const detail = await app.request(`/api/uichecks/${checkId}/runs/${run.id}`, { headers: agentHeaders });
  const json = (await detail.json()) as { verdict: unknown };
  expect(json.verdict).toBeNull();
});

test("an admin session can also record a verdict", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const res = await app.request(verdictUrl(), { method: "POST", headers: { cookie, ...JSON_HEADERS }, body: body() });
  expect(res.status).toBe(201);
});

test("no credential → 401", async () => {
  const res = await app.request(verdictUrl(), { method: "POST", headers: JSON_HEADERS, body: body() });
  expect(res.status).toBe(401);
});

test("a wrong bearer token → 401", async () => {
  const res = await app.request(verdictUrl(), {
    method: "POST",
    headers: { authorization: "Bearer wrong-token", ...JSON_HEADERS },
    body: body(),
  });
  expect(res.status).toBe(401);
});

test("the agent token is rejected when the app has no agentToken configured", async () => {
  const noAgent = makeApp({ agentToken: undefined });
  const res = await noAgent.request(verdictUrl(), { method: "POST", headers: agentHeaders, body: body() });
  expect(res.status).toBe(401);
});

test("an invalid verdict kind → 400 with the field name", async () => {
  const res = await app.request(verdictUrl(), { method: "POST", headers: agentHeaders, body: body({ verdict: "broken" }) });
  expect(res.status).toBe(400);
  expect((await res.json()).field).toBe("verdict");
});

test("a verdict for a missing run → 404", async () => {
  const res = await app.request(`/api/uichecks/${checkId}/runs/no-such-run/verdict`, {
    method: "POST",
    headers: agentHeaders,
    body: body(),
  });
  expect(res.status).toBe(404);
});

test("the scoped agent token cannot run-now or promote (admin-only) → 403", async () => {
  const runNow = await app.request(`/api/uichecks/${checkId}/run`, { method: "POST", headers: agentHeaders });
  expect(runNow.status).toBe(403);
  const promote = await app.request(`/api/uichecks/${checkId}/runs/${run.id}/promote`, {
    method: "POST",
    headers: agentHeaders,
  });
  expect(promote.status).toBe(403);
});
