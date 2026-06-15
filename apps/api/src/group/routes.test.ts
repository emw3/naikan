import { beforeEach, expect, test } from "bun:test";
import { createConfigRepo, InMemoryConfigStore, type ConfigRepo } from "@naikan/config-repo";
import { createGroupApp } from "./routes.ts";
import { createAuth, type Auth } from "../auth/service.ts";
import { InMemorySessionStore, InMemoryUserStore } from "../auth/in-memory-stores.ts";

let app: ReturnType<typeof createGroupApp>;
let auth: Auth;
let repo: ConfigRepo;
let projectId: string;

beforeEach(async () => {
  auth = createAuth({ users: new InMemoryUserStore(), sessions: new InMemorySessionStore() });
  await auth.createUser({ email: "admin@example.com", password: "adminpass", role: "admin" });
  await auth.createUser({ email: "viewer@example.com", password: "viewerpass", role: "viewer" });
  repo = createConfigRepo(new InMemoryConfigStore());
  const project = await repo.createProject({ name: "Acme" }, { id: null });
  projectId = project.id;
  app = createGroupApp({ auth, repo });
});

async function cookieFor(email: string, password: string): Promise<string> {
  const result = await auth.login(email, password);
  return `cm_session=${result!.session.id}`;
}

const JSON_HEADERS = { "content-type": "application/json" };

test("listing groups requires a session (401)", async () => {
  expect((await app.request(`/api/projects/${projectId}/groups`)).status).toBe(401);
});

test("viewer can list groups (200) but cannot create one (403)", async () => {
  const cookie = await cookieFor("viewer@example.com", "viewerpass");
  expect((await app.request(`/api/projects/${projectId}/groups`, { headers: { cookie } })).status).toBe(200);
  const created = await app.request(`/api/projects/${projectId}/groups`, {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ name: "prod" }),
  });
  expect(created.status).toBe(403);
});

test("admin creates, reads, updates, and deletes a group", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const created = await app.request(`/api/projects/${projectId}/groups`, {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ name: "prod", defaultIntervalSeconds: 300 }),
  });
  expect(created.status).toBe(201);
  const { group } = (await created.json()) as { group: { id: string; name: string } };
  expect(group.name).toBe("prod");

  expect((await app.request(`/api/groups/${group.id}`, { headers: { cookie } })).status).toBe(200);

  const patched = await app.request(`/api/groups/${group.id}`, {
    method: "PATCH",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ defaultIntervalSeconds: 600 }),
  });
  expect(patched.status).toBe(200);

  expect((await app.request(`/api/groups/${group.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(204);
  expect((await app.request(`/api/groups/${group.id}`, { headers: { cookie } })).status).toBe(404);
});

test("creating a group under a missing project is 404", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const res = await app.request(`/api/projects/missing/groups`, {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ name: "x" }),
  });
  expect(res.status).toBe(404);
});

test("a validation error maps to 400 with the field name", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const res = await app.request(`/api/projects/${projectId}/groups`, {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ name: "x", defaultIntervalSeconds: 0 }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { field?: string };
  expect(body.field).toBe("defaultIntervalSeconds");
});
