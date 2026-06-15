/**
 * Hono glue for the `auth` module: the session cookie name, the typed env that
 * carries the authenticated user, and the `requireAuth` / `requireRole` guards.
 */
import { createMiddleware } from "hono/factory";
import { deleteCookie, getCookie } from "hono/cookie";
import { timingSafeEqual } from "node:crypto";
import type { Auth } from "./service.ts";
import type { Role, User } from "./types.ts";

/** Name of the httpOnly session cookie. */
export const SESSION_COOKIE = "cm_session";

/** Hono env: routes behind `requireAuth` can read the resolved user via `c.get("user")`. */
export interface AuthEnv {
  Variables: { user: User };
}

/**
 * The synthetic principal the regression-judge agent authenticates as via its
 * bearer token (the `@naikan/mcp` server). Deliberately a `viewer`, not an admin:
 * a viewer with no assigned projects reads every project (scope.ts) but cannot
 * mutate config — so a leaked agent token can read runs + record verdicts, never
 * delete a project or manage users. Scoped capability, not a god-token.
 */
export const AGENT_PRINCIPAL: User = {
  id: "agent:naikan-judge",
  email: "agent@naikan.local",
  role: "viewer",
  createdAt: new Date(0),
};

export interface RequireAuthOptions {
  /**
   * When set, an `Authorization: Bearer <token>` equal to this value authenticates
   * as {@link AGENT_PRINCIPAL}. Unset (no `NAIKAN_AGENT_TOKEN`) → session-cookie only,
   * so the platform still boots and serves without the agent ever being configured.
   */
  agentToken?: string;
}

/** Extract the token from an `Authorization: Bearer <token>` header, or null. */
function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/** Constant-time string compare (avoids leaking the token via compare timing). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Resolves the caller to a user or short-circuits with 401. Two credentials:
 *   1. a scoped agent bearer token (when `opts.agentToken` is configured) → the
 *      read-only {@link AGENT_PRINCIPAL}; checked first so the agent never needs a
 *      cookie.
 *   2. the `cm_session` httpOnly cookie → the logged-in user. A present-but-dead
 *      cookie is cleared so the browser stops resending it.
 */
export function requireAuth(auth: Auth, opts: RequireAuthOptions = {}) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const bearer = bearerToken(c.req.header("authorization"));
    if (opts.agentToken && bearer && safeEqual(bearer, opts.agentToken)) {
      c.set("user", AGENT_PRINCIPAL);
      await next();
      return;
    }
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return c.json({ error: "unauthenticated" }, 401);
    const user = await auth.validateSession(token);
    if (!user) {
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.json({ error: "unauthenticated" }, 401);
    }
    c.set("user", user);
    await next();
  });
}

/** Requires the resolved user to hold `role`; 403 otherwise. Use after `requireAuth`. */
export function requireRole(role: Role) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    if (c.get("user").role !== role) return c.json({ error: "forbidden" }, 403);
    await next();
  });
}
