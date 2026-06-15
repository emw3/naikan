/**
 * HTTP surface for `auth`: the login/logout/me endpoints and the admin-only
 * Users CRUD, mounted under `/api`. `createApiApp` builds a standalone Hono app
 * (used directly by the integration tests and mounted by the API entrypoint),
 * with the auth service and cookie security injected.
 */
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { requireAuth, requireRole, SESSION_COOKIE, type AuthEnv } from "./middleware.ts";
import { isRole } from "./types.ts";
import type { Auth } from "./service.ts";

export interface ApiAppOptions {
  auth: Auth;
  /** Set the `Secure` flag on the session cookie (true in production / HTTPS). */
  secureCookie: boolean;
  /** Cookie + session max age in seconds. Defaults to 7 days. */
  sessionMaxAgeSeconds?: number;
}

const DEFAULT_MAX_AGE = 7 * 24 * 60 * 60;

export function createApiApp(opts: ApiAppOptions) {
  const { auth, secureCookie } = opts;
  const maxAge = opts.sessionMaxAgeSeconds ?? DEFAULT_MAX_AGE;
  const app = new Hono<AuthEnv>();

  // ---- Authentication ----
  app.post("/api/auth/login", async (c) => {
    const body = await readJson(c);
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) return c.json({ error: "email and password required" }, 400);

    const result = await auth.login(email, password);
    if (!result) return c.json({ error: "invalid credentials" }, 401);

    setCookie(c, SESSION_COOKIE, result.session.id, {
      httpOnly: true,
      secure: secureCookie,
      sameSite: "Lax",
      path: "/",
      maxAge,
    });
    return c.json({ user: result.user });
  });

  app.post("/api/auth/logout", requireAuth(auth), async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await auth.logout(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.body(null, 204);
  });

  app.get("/api/auth/me", requireAuth(auth), (c) => c.json({ user: c.get("user") }));

  // ---- Admin-only Users CRUD ----
  const admin = [requireAuth(auth), requireRole("admin")] as const;

  app.get("/api/users", ...admin, async (c) => c.json({ users: await auth.listUsers() }));

  app.post("/api/users", ...admin, async (c) => {
    const body = await readJson(c);
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const role = body.role;
    if (!email || !password) return c.json({ error: "email and password required" }, 400);
    if (!isRole(role)) return c.json({ error: "role must be 'admin' or 'viewer'" }, 400);
    try {
      const user = await auth.createUser({ email, password, role });
      return c.json({ user }, 201);
    } catch {
      return c.json({ error: "email already in use" }, 409);
    }
  });

  app.patch("/api/users/:id", ...admin, async (c) => {
    const body = await readJson(c);
    if (!isRole(body.role)) return c.json({ error: "role must be 'admin' or 'viewer'" }, 400);
    const user = await auth.changeRole(c.req.param("id"), body.role);
    if (!user) return c.json({ error: "user not found" }, 404);
    return c.json({ user });
  });

  app.delete("/api/users/:id", ...admin, async (c) => {
    const deleted = await auth.softDeleteUser(c.req.param("id"));
    if (!deleted) return c.json({ error: "user not found" }, 404);
    return c.body(null, 204);
  });

  return app;
}

/** Parses a JSON body, tolerating an empty/invalid body as `{}`. */
async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const parsed = await c.req.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
