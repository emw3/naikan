/**
 * HTTP surface for heartbeat checks (issue #06), mounted under `/api`.
 *
 * Checks are nested under a Site for list/create and flat for get/update/delete,
 * mirroring the Site routes. Reads are open to any authenticated user; writes —
 * including "run now" — are admin-only. Run-now invokes the runner synchronously,
 * persists a CheckRun, and returns it. The runner is injected (`runCheck`) so the
 * HTTP layer is testable without real network/DNS/TLS; it defaults to the live
 * `@naikan/heartbeat-runner`.
 */
import { Hono } from "hono";
import { runHeartbeat, type CheckRunResult } from "@naikan/heartbeat-runner";
import { requireAuth, requireRole, type AuthEnv } from "../auth/middleware.ts";
import { projectGate } from "../auth/scope.ts";
import type { Auth } from "../auth/service.ts";
import {
  applyIncidentForRun,
  ValidationError,
  type Actor,
  type ConfigRepo,
  type HeartbeatCheck,
  type HeartbeatCheckInput,
  type HeartbeatCheckPatch,
} from "@naikan/config-repo";
import type { IncidentAlertEvent } from "@naikan/alerter";

/** Executes one check against a site base URL. Defaults to the live runner. */
export type RunCheck = (baseUrl: string, check: HeartbeatCheck) => Promise<CheckRunResult>;

export interface HeartbeatAppOptions {
  auth: Auth;
  repo: ConfigRepo;
  /** Override the executor in tests; defaults to the real `runHeartbeat`. */
  runCheck?: RunCheck;
  /** Optional incident-alert sink (#10); omitted → silent transitions. */
  alerter?: (event: IncidentAlertEvent) => Promise<void>;
}

const liveRunCheck: RunCheck = (baseUrl, check) =>
  runHeartbeat(baseUrl, {
    path: check.path,
    bodyAssertion: check.bodyAssertion,
    certCheck: check.certCheck,
    dnsCheck: check.dnsCheck,
  });

export function createHeartbeatApp(opts: HeartbeatAppOptions) {
  const { auth, repo } = opts;
  const runCheck = opts.runCheck ?? liveRunCheck;
  const alerter = opts.alerter;
  const app = new Hono<AuthEnv>();

  const read = [requireAuth(auth)] as const;
  const write = [requireAuth(auth), requireRole("admin")] as const;

  const actorOf = (c: { get: (k: "user") => { id: string } }): Actor => ({ id: c.get("user").id });

  // ---- Checks (nested under a site for create/list, flat for get/update/delete) ----
  app.get("/api/sites/:siteId/checks", ...read, async (c) => {
    const site = await repo.getSite(c.req.param("siteId"));
    // Manager scoping (#16): treat a site outside the user's portfolio as absent.
    if (!site || !(await projectGate(repo, c.get("user")))(site.projectId)) {
      return c.json({ error: "site not found" }, 404);
    }
    return c.json({ checks: await repo.listChecks(site.id) });
  });

  app.post("/api/sites/:siteId/checks", ...write, async (c) => {
    const site = await repo.getSite(c.req.param("siteId"));
    if (!site) return c.json({ error: "site not found" }, 404);
    const body = await readJson(c);
    return withValidation(c, async () => {
      const check = await repo.createCheck(
        { ...body, siteId: site.id } as unknown as HeartbeatCheckInput,
        actorOf(c),
      );
      return c.json({ check }, 201);
    });
  });

  app.get("/api/checks/:id", ...read, async (c) => {
    const check = await repo.getCheck(c.req.param("id"));
    if (!check) return c.json({ error: "check not found" }, 404);
    const site = await repo.getSite(check.siteId);
    if (!site || !(await projectGate(repo, c.get("user")))(site.projectId)) {
      return c.json({ error: "check not found" }, 404);
    }
    return c.json({ check });
  });

  app.patch("/api/checks/:id", ...write, async (c) => {
    const body = await readJson(c);
    return withValidation(c, async () => {
      const check = await repo.updateCheck(
        c.req.param("id"),
        body as unknown as HeartbeatCheckPatch,
        actorOf(c),
      );
      if (!check) return c.json({ error: "check not found" }, 404);
      return c.json({ check });
    });
  });

  app.delete("/api/checks/:id", ...write, async (c) => {
    const deleted = await repo.deleteCheck(c.req.param("id"), actorOf(c));
    if (!deleted) return c.json({ error: "check not found" }, 404);
    return c.body(null, 204);
  });

  // ---- Run now (synchronous execute → persist CheckRun → return it) ----
  app.post("/api/checks/:id/run", ...write, async (c) => {
    const check = await repo.getCheck(c.req.param("id"));
    if (!check) return c.json({ error: "check not found" }, 404);
    const site = await repo.getSite(check.siteId);
    if (!site) return c.json({ error: "site not found" }, 404);

    const result = await runCheck(site.baseUrl, check);
    const run = await repo.recordRun({
      checkId: check.id,
      checkType: "heartbeat",
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      status: result.status,
      latencyMs: result.latencyMs,
      error: result.error,
    });
    // After each CheckRun, resolve incident state (open on N fails / close on 2 passes)
    // and fire the alert on a transition (#10) when an alerter is wired.
    await applyIncidentForRun({ repo, checkId: check.id, alerter });
    return c.json({ run });
  });

  app.get("/api/checks/:id/runs", ...read, async (c) => {
    const check = await repo.getCheck(c.req.param("id"));
    if (!check) return c.json({ error: "check not found" }, 404);
    const site = await repo.getSite(check.siteId);
    if (!site || !(await projectGate(repo, c.get("user")))(site.projectId)) {
      return c.json({ error: "check not found" }, 404);
    }
    return c.json({ runs: await repo.listRuns(check.id) });
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
