import { beforeEach, expect, test } from "bun:test";
import { createConfigRepo, InMemoryConfigStore, type ConfigRepo } from "@naikan/config-repo";
import { createConfigApp } from "./routes.ts";
import { createAuth, type Auth } from "../auth/service.ts";
import { InMemorySessionStore, InMemoryUserStore } from "../auth/in-memory-stores.ts";

let app: ReturnType<typeof createConfigApp>;
let auth: Auth;
let repo: ConfigRepo;

beforeEach(async () => {
  auth = createAuth({ users: new InMemoryUserStore(), sessions: new InMemorySessionStore() });
  await auth.createUser({ email: "admin@example.com", password: "adminpass", role: "admin" });
  await auth.createUser({ email: "viewer@example.com", password: "viewerpass", role: "viewer" });
  repo = createConfigRepo(new InMemoryConfigStore());
  app = createConfigApp({ auth, repo });
});

/** Logs in via the auth service and returns the `cm_session=...` cookie header. */
async function cookieFor(email: string, password: string): Promise<string> {
  const result = await auth.login(email, password);
  return `cm_session=${result!.session.id}`;
}

const JSON_HEADERS = { "content-type": "application/json" };

function projectBody(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "Acme Coffee",
    contacts: "Mara Ortiz",
    slackChannel: "#project-acme",
    alertEmails: ["alerts@acme.test"],
    retentionDays: 90,
    ...over,
  });
}

// ---- auth / role gating ----

test("listing projects requires a session (401)", async () => {
  const res = await app.request("/api/projects");
  expect(res.status).toBe(401);
});

test("viewer can list projects (200) but cannot create one (403)", async () => {
  const cookie = await cookieFor("viewer@example.com", "viewerpass");
  expect((await app.request("/api/projects", { headers: { cookie } })).status).toBe(200);
  const create = await app.request("/api/projects", {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: projectBody(),
  });
  expect(create.status).toBe(403);
});

// ---- project CRUD happy path ----

test("admin creates, reads, updates, and deletes a project", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");

  const created = await app.request("/api/projects", {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: projectBody(),
  });
  expect(created.status).toBe(201);
  const { project } = (await created.json()) as { project: { id: string; name: string } };
  expect(project.name).toBe("Acme Coffee");

  const got = await app.request(`/api/projects/${project.id}`, { headers: { cookie } });
  expect(got.status).toBe(200);

  const patched = await app.request(`/api/projects/${project.id}`, {
    method: "PATCH",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ name: "Acme Renamed" }),
  });
  expect(patched.status).toBe(200);
  expect(((await patched.json()) as { project: { name: string } }).project.name).toBe("Acme Renamed");

  const del = await app.request(`/api/projects/${project.id}`, { method: "DELETE", headers: { cookie } });
  expect(del.status).toBe(204);
  expect((await app.request(`/api/projects/${project.id}`, { headers: { cookie } })).status).toBe(404);
});

test("GET unknown project returns 404", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  expect((await app.request("/api/projects/nope", { headers: { cookie } })).status).toBe(404);
});

// ---- validation ----

test("creating a project with a blank name returns 400 with the field", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const res = await app.request("/api/projects", {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: projectBody({ name: "" }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { field: string }).field).toBe("name");
});

test("creating a project with a non-positive retention returns 400", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const res = await app.request("/api/projects", {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: projectBody({ retentionDays: 0 }),
  });
  expect(res.status).toBe(400);
});

test("creating a project with a bad email returns 400", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const res = await app.request("/api/projects", {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: projectBody({ alertEmails: ["bad"] }),
  });
  expect(res.status).toBe(400);
});

test("creating a project with a bad slack channel returns 400", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const res = await app.request("/api/projects", {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: projectBody({ slackChannel: "nope" }),
  });
  expect(res.status).toBe(400);
});

// ---- sites ----

test("admin attaches a site to a project and lists it", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const { project } = (await (
    await app.request("/api/projects", { method: "POST", headers: { cookie, ...JSON_HEADERS }, body: projectBody() })
  ).json()) as { project: { id: string } };

  const created = await app.request(`/api/projects/${project.id}/sites`, {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ baseUrl: "https://acme.test" }),
  });
  expect(created.status).toBe(201);

  const list = await app.request(`/api/projects/${project.id}/sites`, { headers: { cookie } });
  expect(((await list.json()) as { sites: unknown[] }).sites).toHaveLength(1);
});

test("attaching a site with a bad base URL returns 400", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const { project } = (await (
    await app.request("/api/projects", { method: "POST", headers: { cookie, ...JSON_HEADERS }, body: projectBody() })
  ).json()) as { project: { id: string } };
  const res = await app.request(`/api/projects/${project.id}/sites`, {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ baseUrl: "ftp://acme.test" }),
  });
  expect(res.status).toBe(400);
});

test("attaching a site to an unknown project returns 404", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const res = await app.request("/api/projects/nope/sites", {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: JSON.stringify({ baseUrl: "https://acme.test" }),
  });
  expect(res.status).toBe(404);
});

test("viewer cannot delete a site (403)", async () => {
  const admin = await cookieFor("admin@example.com", "adminpass");
  const { project } = (await (
    await app.request("/api/projects", { method: "POST", headers: { cookie: admin, ...JSON_HEADERS }, body: projectBody() })
  ).json()) as { project: { id: string } };
  const { site } = (await (
    await app.request(`/api/projects/${project.id}/sites`, {
      method: "POST",
      headers: { cookie: admin, ...JSON_HEADERS },
      body: JSON.stringify({ baseUrl: "https://acme.test" }),
    })
  ).json()) as { site: { id: string } };

  const viewer = await cookieFor("viewer@example.com", "viewerpass");
  const res = await app.request(`/api/sites/${site.id}`, { method: "DELETE", headers: { cookie: viewer } });
  expect(res.status).toBe(403);
});

// ---- audit ----

test("creating a project writes an audit-log row attributed to the admin", async () => {
  const cookie = await cookieFor("admin@example.com", "adminpass");
  const adminUser = (await auth.listUsers()).find((u) => u.email === "admin@example.com")!;

  const created = await app.request("/api/projects", {
    method: "POST",
    headers: { cookie, ...JSON_HEADERS },
    body: projectBody(),
  });
  const { project } = (await created.json()) as { project: { id: string } };

  const log = await repo.listAudit();
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({
    entityType: "project",
    entityId: project.id,
    action: "create",
    userId: adminUser.id,
  });
});

// ---- manager scoping on read surfaces (#16) ----

/** Seed three projects, the first two assigned to `managerId`, and return their ids. */
async function seedScopedProjects(managerId: string): Promise<{ mine: string[]; other: string }> {
  const a = await repo.createProject({ name: "Mine A", assignedManagerId: managerId }, { id: null });
  const b = await repo.createProject({ name: "Mine B", assignedManagerId: managerId }, { id: null });
  const c = await repo.createProject({ name: "Someone else's" }, { id: null });
  return { mine: [a.id, b.id], other: c.id };
}

test("a manager's project list is scoped to their assigned projects", async () => {
  await auth.createUser({ email: "mara@example.com", password: "marapass", role: "viewer" });
  const mara = (await auth.listUsers()).find((u) => u.email === "mara@example.com")!;
  const { mine } = await seedScopedProjects(mara.id);

  const cookie = await cookieFor("mara@example.com", "marapass");
  const res = await app.request("/api/projects", { headers: { cookie } });
  const { projects } = (await res.json()) as { projects: { id: string }[] };
  expect(projects.map((x) => x.id).sort()).toEqual([...mine].sort());
});

test("an admin and a plain (unassigned) viewer both see every project", async () => {
  await auth.createUser({ email: "mara@example.com", password: "marapass", role: "viewer" });
  const mara = (await auth.listUsers()).find((u) => u.email === "mara@example.com")!;
  await seedScopedProjects(mara.id); // 3 projects total

  for (const [email, password] of [
    ["admin@example.com", "adminpass"],
    ["viewer@example.com", "viewerpass"],
  ]) {
    const cookie = await cookieFor(email!, password!);
    const res = await app.request("/api/projects", { headers: { cookie } });
    const { projects } = (await res.json()) as { projects: unknown[] };
    expect(projects).toHaveLength(3);
  }
});

test("a manager gets 404 fetching a project outside their portfolio", async () => {
  await auth.createUser({ email: "mara@example.com", password: "marapass", role: "viewer" });
  const mara = (await auth.listUsers()).find((u) => u.email === "mara@example.com")!;
  const { mine, other } = await seedScopedProjects(mara.id);

  const cookie = await cookieFor("mara@example.com", "marapass");
  expect((await app.request(`/api/projects/${mine[0]}`, { headers: { cookie } })).status).toBe(200);
  expect((await app.request(`/api/projects/${other}`, { headers: { cookie } })).status).toBe(404);
});

test("site reads are scoped to the manager's portfolio too", async () => {
  await auth.createUser({ email: "mara@example.com", password: "marapass", role: "viewer" });
  const mara = (await auth.listUsers()).find((u) => u.email === "mara@example.com")!;
  const { mine, other } = await seedScopedProjects(mara.id);
  const mySite = await repo.createSite({ projectId: mine[0]!, baseUrl: "https://mine.test" }, { id: null });
  const otherSite = await repo.createSite({ projectId: other, baseUrl: "https://other.test" }, { id: null });

  const cookie = await cookieFor("mara@example.com", "marapass");
  // Own project: sites list + single site both reachable.
  expect((await app.request(`/api/projects/${mine[0]}/sites`, { headers: { cookie } })).status).toBe(200);
  expect((await app.request(`/api/sites/${mySite.id}`, { headers: { cookie } })).status).toBe(200);
  // Outside the portfolio: both 404 (no leak), even with a valid id.
  expect((await app.request(`/api/projects/${other}/sites`, { headers: { cookie } })).status).toBe(404);
  expect((await app.request(`/api/sites/${otherSite.id}`, { headers: { cookie } })).status).toBe(404);
});
