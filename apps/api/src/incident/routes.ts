/**
 * HTTP surface for incidents (issue #09), mounted under `/api`. Read-only — open
 * + closed incidents for a project (PRD viewer stories 17/18), available to any
 * authenticated user, manager-scoped to their portfolio (#16). Incidents are
 * opened/closed by the orchestrator after each CheckRun; there are no write
 * routes here.
 */
import { Hono } from "hono";
import { requireAuth, type AuthEnv } from "../auth/middleware.ts";
import { projectGate } from "../auth/scope.ts";
import type { Auth } from "../auth/service.ts";
import type { ConfigRepo } from "@naikan/config-repo";

export interface IncidentAppOptions {
  auth: Auth;
  repo: ConfigRepo;
}

export function createIncidentApp(opts: IncidentAppOptions) {
  const { auth, repo } = opts;
  const app = new Hono<AuthEnv>();
  const read = [requireAuth(auth)] as const;

  app.get("/api/projects/:id/incidents", ...read, async (c) => {
    const project = await repo.getProject(c.req.param("id"));
    // Manager scoping (#16): a project outside the user's portfolio reads as absent.
    if (!project || !(await projectGate(repo, c.get("user")))(project.id)) {
      return c.json({ error: "project not found" }, 404);
    }
    const all = await repo.listProjectIncidents(project.id);
    const open = all.filter((i) => i.closedAt === null);
    const closed = all
      .filter((i) => i.closedAt !== null)
      .sort((a, b) => b.closedAt!.getTime() - a.closedAt!.getTime());
    return c.json({ open, closed });
  });

  return app;
}
