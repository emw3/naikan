/**
 * HTTP surface for the read-only dashboard detail views (issue #16), mounted
 * under `/api`. Every route is read-only and manager-scoped (see scope.ts): it
 * aggregates `CheckRun` + `Incident` rows already populated by #06–#14 and adds
 * no write logic. Deep-links from the digest (#15) and incident alerts (#10)
 * resolve here via `/api/projects/:id/overview`.
 */
import { Hono } from "hono";
import { requireAuth, type AuthEnv } from "../auth/middleware.ts";
import type { Auth } from "../auth/service.ts";
import { canSeeProject, scopeProjects } from "../auth/scope.ts";
import type { CheckRun, ConfigRepo, Incident } from "@naikan/config-repo";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Cap on incidents listed per check on a detail page. */
const RECENT_INCIDENTS = 10;

export interface DashboardAppOptions {
  auth: Auth;
  repo: ConfigRepo;
  /** Clock, injectable for deterministic tests (24h window + incident durations). */
  now?: () => Date;
}

/** The badge a check shows: an open incident dominates; otherwise the last run's verdict. */
export type CheckState = "ok" | "failing" | "incident" | "unknown";

/** Pass/fail tally over a run set. */
export interface RunSummary {
  pass: number;
  fail: number;
  total: number;
}

function summarize(runs: CheckRun[]): RunSummary {
  let pass = 0;
  for (const r of runs) if (r.status === "pass") pass++;
  return { pass, fail: runs.length - pass, total: runs.length };
}

function stateFrom(latest: CheckRun | undefined, hasOpenIncident: boolean): CheckState {
  if (hasOpenIncident) return "incident";
  if (!latest) return "unknown";
  return latest.status === "pass" ? "ok" : "failing";
}

/** Host portion of a base URL for a human check label (matches digest/alerter). */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function createDashboardApp(opts: DashboardAppOptions) {
  const { auth, repo } = opts;
  const now = opts.now ?? (() => new Date());
  const app = new Hono<AuthEnv>();
  const read = [requireAuth(auth)] as const;

  /** Newest run for a check, or undefined — the current-state input. */
  const latestRun = async (checkId: string): Promise<CheckRun | undefined> =>
    (await repo.listRuns(checkId, 1))[0];

  /**
   * Resolve a polymorphic incident/run `checkId` to its kind, path and owning
   * site/project — the data a cross-check view needs to label a row. Tries the
   * heartbeat table first, then the UI-check table. Null if the check is gone.
   */
  const resolveCheckRef = async (
    checkId: string,
  ): Promise<{ kind: "heartbeat" | "uicheck"; path: string; siteId: string } | null> => {
    const hb = await repo.getCheck(checkId);
    if (hb) return { kind: "heartbeat", path: hb.path, siteId: hb.siteId };
    const ui = await repo.getUICheck(checkId);
    if (ui) return { kind: "uicheck", path: ui.path, siteId: ui.siteId };
    return null;
  };

  // ---- Project overview: every check under a project with its last-24h tally + state ----
  app.get("/api/projects/:id/overview", ...read, async (c) => {
    const projects = await repo.listProjects();
    const project = projects.find((x) => x.id === c.req.param("id")) ?? null;
    if (!project) return c.json({ error: "project not found" }, 404);
    if (!canSeeProject(c.get("user"), project.id, projects)) {
      return c.json({ error: "project not found" }, 404);
    }

    const to = now();
    const from = new Date(to.getTime() - DAY_MS);
    const sites = await repo.listSites(project.id);
    const checks: Array<{
      id: string;
      kind: "heartbeat" | "uicheck";
      siteId: string;
      host: string;
      path: string;
      state: CheckState;
      last24h: RunSummary;
      openIncident: boolean;
    }> = [];
    let openIncidentCount = 0;

    for (const site of sites) {
      const host = hostOf(site.baseUrl);
      const heartbeats = await repo.listChecks(site.id);
      const uichecks = await repo.listUIChecks(site.id);
      for (const check of [
        ...heartbeats.map((h) => ({ id: h.id, kind: "heartbeat" as const, path: h.path })),
        ...uichecks.map((u) => ({ id: u.id, kind: "uicheck" as const, path: u.path })),
      ]) {
        const [windowRuns, openIncident, latest] = await Promise.all([
          repo.listRunsInWindow(check.id, from, to),
          repo.getOpenIncident(check.id),
          latestRun(check.id),
        ]);
        if (openIncident) openIncidentCount++;
        checks.push({
          id: check.id,
          kind: check.kind,
          siteId: site.id,
          host,
          path: check.path,
          state: stateFrom(latest, openIncident !== null),
          last24h: summarize(windowRuns),
          openIncident: openIncident !== null,
        });
      }
    }

    return c.json({ project, openIncidentCount, checks });
  });

  // ---- Heartbeat check detail: 24h timeline + recent incidents ----
  app.get("/api/checks/:id/detail", ...read, async (c) => {
    const check = await repo.getCheck(c.req.param("id"));
    if (!check) return c.json({ error: "check not found" }, 404);
    const site = await repo.getSite(check.siteId);
    if (!site) return c.json({ error: "check not found" }, 404);
    if (!canSeeProject(c.get("user"), site.projectId, await repo.listProjects())) {
      return c.json({ error: "check not found" }, 404);
    }

    const to = now();
    const from = new Date(to.getTime() - DAY_MS);
    const [timeline, openIncident, latest, projectIncidents] = await Promise.all([
      repo.listRunsInWindow(check.id, from, to), // oldest-first — a left-to-right timeline
      repo.getOpenIncident(check.id),
      latestRun(check.id),
      repo.listProjectIncidents(site.projectId),
    ]);
    const recentIncidents = projectIncidents
      .filter((i) => i.checkId === check.id)
      .slice(0, RECENT_INCIDENTS);

    return c.json({
      check,
      projectId: site.projectId,
      host: hostOf(site.baseUrl),
      state: stateFrom(latest, openIncident !== null),
      last24h: summarize(timeline),
      timeline,
      recentIncidents,
    });
  });

  // ---- UI check detail: current state + recent incidents (runs/signals via #11b/#12/#13 routes) ----
  app.get("/api/uichecks/:id/detail", ...read, async (c) => {
    const check = await repo.getUICheck(c.req.param("id"));
    if (!check) return c.json({ error: "check not found" }, 404);
    const site = await repo.getSite(check.siteId);
    if (!site) return c.json({ error: "check not found" }, 404);
    if (!canSeeProject(c.get("user"), site.projectId, await repo.listProjects())) {
      return c.json({ error: "check not found" }, 404);
    }

    const [openIncident, latest, projectIncidents] = await Promise.all([
      repo.getOpenIncident(check.id),
      latestRun(check.id),
      repo.listProjectIncidents(site.projectId),
    ]);
    const recentIncidents = projectIncidents
      .filter((i) => i.checkId === check.id)
      .slice(0, RECENT_INCIDENTS);

    return c.json({
      check,
      projectId: site.projectId,
      host: hostOf(site.baseUrl),
      state: stateFrom(latest, openIncident !== null),
      recentIncidents,
    });
  });

  // ---- Incidents across the user's projects, filterable by open/closed ----
  app.get("/api/incidents", ...read, async (c) => {
    const status = c.req.query("status") === "closed" ? "closed" : "open";
    const projects = scopeProjects(c.get("user"), await repo.listProjects());
    const nowMs = now().getTime();
    const siteCache = new Map<string, { projectId: string; host: string } | null>();

    const rows: Array<{
      id: string;
      checkId: string;
      checkType: "heartbeat" | "uicheck" | null;
      checkLabel: string;
      projectId: string;
      projectName: string;
      openedAt: Date;
      closedAt: Date | null;
      durationMs: number;
      open: boolean;
    }> = [];

    for (const project of projects) {
      const incidents = await repo.listProjectIncidents(project.id);
      for (const inc of incidents) {
        const open = inc.closedAt === null;
        if (status === "open" ? !open : open) continue;
        const ref = await resolveCheckRef(inc.checkId);
        let host = "";
        if (ref) {
          if (!siteCache.has(ref.siteId)) {
            const site = await repo.getSite(ref.siteId);
            siteCache.set(ref.siteId, site ? { projectId: site.projectId, host: hostOf(site.baseUrl) } : null);
          }
          host = siteCache.get(ref.siteId)?.host ?? "";
        }
        rows.push({
          id: inc.id,
          checkId: inc.checkId,
          checkType: ref?.kind ?? null,
          checkLabel: ref ? `${host}${ref.path}` : inc.checkId,
          projectId: project.id,
          projectName: project.name,
          openedAt: inc.openedAt,
          closedAt: inc.closedAt,
          durationMs: (inc.closedAt?.getTime() ?? nowMs) - inc.openedAt.getTime(),
          open,
        });
      }
    }

    rows.sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime());
    return c.json({ incidents: rows });
  });

  return app;
}
