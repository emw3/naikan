import { beforeEach, expect, test } from "bun:test";
import { createApiApp } from "./routes.ts";
import { createAuth } from "./service.ts";
import { InMemorySessionStore, InMemoryUserStore } from "./in-memory-stores.ts";

let app: ReturnType<typeof createApiApp>;

beforeEach(async () => {
  const users = new InMemoryUserStore();
  const sessions = new InMemorySessionStore();
  const auth = createAuth({ users, sessions });
  await auth.createUser({ email: "admin@example.com", password: "adminpass", role: "admin" });
  await auth.createUser({ email: "viewer@example.com", password: "viewerpass", role: "viewer" });
  app = createApiApp({ auth, secureCookie: false });
});

/** Logs in and returns the `cm_session=...` cookie pair to send on later requests. */
async function loginCookie(email: string, password: string): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie");
  expect(setCookie).toContain("cm_session=");
  expect(setCookie?.toLowerCase()).toContain("httponly");
  return setCookie!.split(";")[0]!;
}

test("login with bad credentials returns 401 and sets no cookie", async () => {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: "nope" }),
  });
  expect(res.status).toBe(401);
  expect(res.headers.get("set-cookie")).toBeNull();
});

test("protected route returns 401 without a session", async () => {
  const res = await app.request("/api/users");
  expect(res.status).toBe(401);
});

test("GET /api/auth/me returns the logged-in user", async () => {
  const cookie = await loginCookie("viewer@example.com", "viewerpass");
  const res = await app.request("/api/auth/me", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { email: string; role: string } };
  expect(body.user.email).toBe("viewer@example.com");
  expect(body.user.role).toBe("viewer");
});

test("viewer is forbidden (403) from the admin-only Users list", async () => {
  const cookie = await loginCookie("viewer@example.com", "viewerpass");
  const res = await app.request("/api/users", { headers: { cookie } });
  expect(res.status).toBe(403);
});

test("admin can list users (200)", async () => {
  const cookie = await loginCookie("admin@example.com", "adminpass");
  const res = await app.request("/api/users", { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { users: unknown[] };
  expect(body.users).toHaveLength(2);
});

test("admin can create a user (201)", async () => {
  const cookie = await loginCookie("admin@example.com", "adminpass");
  const res = await app.request("/api/users", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ email: "new@example.com", password: "newpass12", role: "viewer" }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { user: { email: string; role: string } };
  expect(body.user.email).toBe("new@example.com");
});

test("creating a duplicate user returns 409", async () => {
  const cookie = await loginCookie("admin@example.com", "adminpass");
  const res = await app.request("/api/users", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: "whatever1", role: "admin" }),
  });
  expect(res.status).toBe(409);
});

test("viewer cannot create a user (403)", async () => {
  const cookie = await loginCookie("viewer@example.com", "viewerpass");
  const res = await app.request("/api/users", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ email: "x@example.com", password: "password1", role: "viewer" }),
  });
  expect(res.status).toBe(403);
});

test("admin can change a user's role and soft-delete them", async () => {
  const cookie = await loginCookie("admin@example.com", "adminpass");
  const list = (await (await app.request("/api/users", { headers: { cookie } })).json()) as {
    users: { id: string; email: string }[];
  };
  const viewer = list.users.find((u) => u.email === "viewer@example.com")!;

  const patch = await app.request(`/api/users/${viewer.id}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ role: "admin" }),
  });
  expect(patch.status).toBe(200);
  expect(((await patch.json()) as { user: { role: string } }).user.role).toBe("admin");

  const del = await app.request(`/api/users/${viewer.id}`, { method: "DELETE", headers: { cookie } });
  expect(del.status).toBe(204);

  const after = (await (await app.request("/api/users", { headers: { cookie } })).json()) as {
    users: unknown[];
  };
  expect(after.users).toHaveLength(1);
});

test("logout clears the session so /me returns 401", async () => {
  const cookie = await loginCookie("admin@example.com", "adminpass");
  const out = await app.request("/api/auth/logout", { method: "POST", headers: { cookie } });
  expect(out.status).toBe(204);
  const me = await app.request("/api/auth/me", { headers: { cookie } });
  expect(me.status).toBe(401);
});
