/**
 * HTTP surface for `config-repo`: Project + Site CRUD (issue #05), mounted under
 * `/api`. Reads are open to any authenticated user (Viewer included); writes are
 * admin-only. Every mutation passes the acting user to the repo, which records it
 * in the audit log. `ValidationError` from the repo maps to 400 with the field.
 */
import { Hono } from "hono";
import { requireAuth, requireRole, type AuthEnv } from "../auth/middleware.ts";
import type { Auth } from "../auth/service.ts";
import { canSeeProject, scopeProjects } from "../auth/scope.ts";
import {
  ValidationError,
  type Actor,
  type ProjectInput,
  type ProjectPatch,
  type ConfigRepo,
} from "@naikan/config-repo";

export interface ConfigAppOptions {
  auth: Auth;
  repo: ConfigRepo;
}

export function createConfigApp(opts: ConfigAppOptions) {
  const { auth, repo } = opts;
  const app = new Hono<AuthEnv>();

  const read = [requireAuth(auth)] as const;
  const write = [requireAuth(auth), requireRole("admin")] as const;

  const actorOf = (c: { get: (k: "user") => { id: string } }): Actor => ({ id: c.get("user").id });

  // ---- Projects ----
  // Reads are manager-scoped (#16): admins + plain viewers see every project; a
  // user assigned as a Project's manager sees only their assigned projects.
  app.get("/api/projects", ...read, async (c) =>
    c.json({ projects: scopeProjects(c.get("user"), await repo.listProjects()) }),
  );

  app.post("/api/projects", ...write, async (c) => {
    const body = await readJson(c);
    return withValidation(c, async () => {
      // The repo is the validation boundary; it coerces/validates these raw fields.
      const project = await repo.createProject(body as unknown as ProjectInput, actorOf(c));
      return c.json({ project }, 201);
    });
  });

  app.get("/api/projects/:id", ...read, async (c) => {
    const project = await repo.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    // A manager requesting a project outside their portfolio gets 404 (don't leak
    // existence), consistent with the scoped list above.
    if (!canSeeProject(c.get("user"), project.id, await repo.listProjects())) {
      return c.json({ error: "project not found" }, 404);
    }
    return c.json({ project });
  });

  app.patch("/api/projects/:id", ...write, async (c) => {
    const body = await readJson(c);
    return withValidation(c, async () => {
      const project = await repo.updateProject(
        c.req.param("id"),
        body as unknown as ProjectPatch,
        actorOf(c),
      );
      if (!project) return c.json({ error: "project not found" }, 404);
      return c.json({ project });
    });
  });

  app.delete("/api/projects/:id", ...write, async (c) => {
    const deleted = await repo.deleteProject(c.req.param("id"), actorOf(c));
    if (!deleted) return c.json({ error: "project not found" }, 404);
    return c.body(null, 204);
  });

  // ---- Sites (nested under a project for create/list, flat for get/update/delete) ----
  app.get("/api/projects/:id/sites", ...read, async (c) => {
    const project = await repo.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    // Same manager scoping as the project reads: don't expose sites of a project
    // outside the user's portfolio.
    if (!canSeeProject(c.get("user"), project.id, await repo.listProjects())) {
      return c.json({ error: "project not found" }, 404);
    }
    return c.json({ sites: await repo.listSites(project.id) });
  });

  app.post("/api/projects/:id/sites", ...write, async (c) => {
    const project = await repo.getProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    const body = await readJson(c);
    return withValidation(c, async () => {
      const site = await repo.createSite(
        { projectId: project.id, baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "" },
        actorOf(c),
      );
      return c.json({ site }, 201);
    });
  });

  app.get("/api/sites/:id", ...read, async (c) => {
    const site = await repo.getSite(c.req.param("id"));
    if (!site) return c.json({ error: "site not found" }, 404);
    // Scope by the site's owning project (manager portfolio).
    if (!canSeeProject(c.get("user"), site.projectId, await repo.listProjects())) {
      return c.json({ error: "site not found" }, 404);
    }
    return c.json({ site });
  });

  app.patch("/api/sites/:id", ...write, async (c) => {
    const body = await readJson(c);
    return withValidation(c, async () => {
      const site = await repo.updateSite(
        c.req.param("id"),
        { baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : undefined },
        actorOf(c),
      );
      if (!site) return c.json({ error: "site not found" }, 404);
      return c.json({ site });
    });
  });

  app.delete("/api/sites/:id", ...write, async (c) => {
    const deleted = await repo.deleteSite(c.req.param("id"), actorOf(c));
    if (!deleted) return c.json({ error: "site not found" }, 404);
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
