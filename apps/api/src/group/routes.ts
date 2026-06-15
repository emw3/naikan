/**
 * HTTP surface for CheckGroups (issue #08), mounted under `/api`. Groups are
 * nested under a project for list/create and flat for get/update/delete,
 * mirroring the Site routes. Reads are open to any authenticated user; writes
 * are admin-only. Every mutation passes the acting user to the repo, which
 * records it in the audit log; `ValidationError` maps to 400 with the field.
 */
import { Hono } from "hono";
import { requireAuth, requireRole, type AuthEnv } from "../auth/middleware.ts";
import { projectGate } from "../auth/scope.ts";
import type { Auth } from "../auth/service.ts";
import {
  ValidationError,
  type Actor,
  type CheckGroupInput,
  type CheckGroupPatch,
  type ConfigRepo,
} from "@naikan/config-repo";

export interface GroupAppOptions {
  auth: Auth;
  repo: ConfigRepo;
}

export function createGroupApp(opts: GroupAppOptions) {
  const { auth, repo } = opts;
  const app = new Hono<AuthEnv>();

  const read = [requireAuth(auth)] as const;
  const write = [requireAuth(auth), requireRole("admin")] as const;
  const actorOf = (c: { get: (k: "user") => { id: string } }): Actor => ({ id: c.get("user").id });

  app.get("/api/projects/:id/groups", ...read, async (c) => {
    const project = await repo.getProject(c.req.param("id"));
    // Manager scoping (#16): a project outside the user's portfolio reads as absent.
    if (!project || !(await projectGate(repo, c.get("user")))(project.id)) {
      return c.json({ error: "project not found" }, 404);
    }
    return c.json({ groups: await repo.listGroups(project.id) });
  });

  app.post("/api/projects/:id/groups", ...write, async (c) => {
    const project = await repo.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    const body = await readJson(c);
    return withValidation(c, async () => {
      const group = await repo.createGroup(
        { ...body, projectId: project.id } as unknown as CheckGroupInput,
        actorOf(c),
      );
      return c.json({ group }, 201);
    });
  });

  app.get("/api/groups/:id", ...read, async (c) => {
    const group = await repo.getGroup(c.req.param("id"));
    if (!group) return c.json({ error: "group not found" }, 404);
    if (!(await projectGate(repo, c.get("user")))(group.projectId)) {
      return c.json({ error: "group not found" }, 404);
    }
    return c.json({ group });
  });

  app.patch("/api/groups/:id", ...write, async (c) => {
    const body = await readJson(c);
    return withValidation(c, async () => {
      const group = await repo.updateGroup(
        c.req.param("id"),
        body as unknown as CheckGroupPatch,
        actorOf(c),
      );
      if (!group) return c.json({ error: "group not found" }, 404);
      return c.json({ group });
    });
  });

  app.delete("/api/groups/:id", ...write, async (c) => {
    const deleted = await repo.deleteGroup(c.req.param("id"), actorOf(c));
    if (!deleted) return c.json({ error: "group not found" }, 404);
    return c.body(null, 204);
  });

  return app;
}

/** Runs a repo write, mapping `ValidationError` to a 400 carrying the field name. */
async function withValidation(
  c: { json: (body: unknown, status?: 400) => Response },
  run: () => Promise<Response>,
): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ValidationError) {
      return c.json({ error: err.message, field: err.field }, 400);
    }
    throw err;
  }
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
