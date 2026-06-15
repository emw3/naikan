import { beforeEach, expect, test } from "bun:test";
import { createAuth } from "./service.ts";
import { InMemorySessionStore, InMemoryUserStore } from "./in-memory-stores.ts";
import type { Auth } from "./service.ts";

// A controllable clock so we can test session expiry deterministically.
let clock: Date;
const now = () => clock;

let auth: Auth;
let users: InMemoryUserStore;
let sessions: InMemorySessionStore;

const SESSION_TTL_MS = 60 * 60 * 1000; // 1h

beforeEach(() => {
  clock = new Date("2026-06-02T09:00:00.000Z");
  users = new InMemoryUserStore(now);
  sessions = new InMemorySessionStore();
  auth = createAuth({ users, sessions, now, sessionTtlMs: SESSION_TTL_MS });
});

async function seedAdmin() {
  return auth.createUser({ email: "admin@example.com", password: "s3cret-pass", role: "admin" });
}

test("login with valid credentials returns a session and the user", async () => {
  const created = await seedAdmin();
  const result = await auth.login("admin@example.com", "s3cret-pass");
  expect(result).not.toBeNull();
  expect(result!.user.id).toBe(created.id);
  expect(result!.user.role).toBe("admin");
  expect(result!.session.id.length).toBeGreaterThan(20);
  // The safe user must never leak the password hash.
  expect((result!.user as unknown as Record<string, unknown>).passwordHash).toBeUndefined();
});

test("login is case-insensitive on email", async () => {
  await seedAdmin();
  const result = await auth.login("Admin@example.com", "s3cret-pass");
  expect(result).not.toBeNull();
});

test("login with a wrong password returns null", async () => {
  await seedAdmin();
  expect(await auth.login("admin@example.com", "wrong")).toBeNull();
});

test("login with an unknown email returns null", async () => {
  expect(await auth.login("nobody@example.com", "whatever")).toBeNull();
});

test("login as a soft-deleted user returns null", async () => {
  const u = await seedAdmin();
  await auth.softDeleteUser(u.id);
  expect(await auth.login("admin@example.com", "s3cret-pass")).toBeNull();
});

test("validateSession returns the user for a fresh token", async () => {
  const u = await seedAdmin();
  const { session } = (await auth.login("admin@example.com", "s3cret-pass"))!;
  const who = await auth.validateSession(session.id);
  expect(who?.id).toBe(u.id);
});

test("validateSession returns null for an unknown token", async () => {
  expect(await auth.validateSession("does-not-exist")).toBeNull();
});

test("validateSession returns null once the session has expired", async () => {
  await seedAdmin();
  const { session } = (await auth.login("admin@example.com", "s3cret-pass"))!;
  clock = new Date(clock.getTime() + SESSION_TTL_MS + 1);
  expect(await auth.validateSession(session.id)).toBeNull();
});

test("logout invalidates the session", async () => {
  await seedAdmin();
  const { session } = (await auth.login("admin@example.com", "s3cret-pass"))!;
  await auth.logout(session.id);
  expect(await auth.validateSession(session.id)).toBeNull();
});

test("validateSession reflects a role change without re-login", async () => {
  const u = await seedAdmin();
  const { session } = (await auth.login("admin@example.com", "s3cret-pass"))!;
  await auth.changeRole(u.id, "viewer");
  const who = await auth.validateSession(session.id);
  expect(who?.role).toBe("viewer");
});

test("soft-deleting a user invalidates their existing sessions", async () => {
  const u = await seedAdmin();
  const { session } = (await auth.login("admin@example.com", "s3cret-pass"))!;
  await auth.softDeleteUser(u.id);
  expect(await auth.validateSession(session.id)).toBeNull();
});

test("listUsers omits soft-deleted users", async () => {
  const a = await seedAdmin();
  const b = await auth.createUser({ email: "v@example.com", password: "viewerpass", role: "viewer" });
  await auth.softDeleteUser(a.id);
  const list = await auth.listUsers();
  expect(list.map((u) => u.id)).toEqual([b.id]);
});

test("createUser rejects a duplicate email", async () => {
  await seedAdmin();
  await expect(
    auth.createUser({ email: "admin@example.com", password: "another", role: "viewer" }),
  ).rejects.toThrow();
});
