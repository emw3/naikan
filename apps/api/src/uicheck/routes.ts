/**
 * HTTP surface for UI checks (issue #11b), mounted under `/api`.
 *
 * Checks are nested under a Site for list/create and flat for get/update/delete,
 * mirroring heartbeat checks. Reads are open to any authenticated user; writes —
 * including "Run now" — are admin-only.
 *
 * Unlike heartbeat run-now (which executes synchronously in this Bun process), UI
 * run-now **enqueues a worker job** and returns 202: Playwright is Node-only and
 * unstable on Bun (ADR-0001/ADR-0006), so the Node worker owns capture. The
 * enqueue seam is injected (`enqueueUIRun`) so the HTTP layer is testable without
 * a live queue.
 *
 * The run-detail route presigns the run's screenshots by reading the manifest the
 * worker wrote (CheckRun.artifactsRef → manifest → per-viewport keys), so the
 * admin UI renders artifacts via short-lived URLs without proxying bytes.
 */
import { Hono } from "hono";
import { requireAuth, requireRole, type AuthEnv } from "../auth/middleware.ts";
import { projectGate } from "../auth/scope.ts";
import type { Auth } from "../auth/service.ts";
import {
  ValidationError,
  type Actor,
  type ConfigRepo,
  type UICheckInput,
  type UICheckPatch,
} from "@naikan/config-repo";
import { artifactKeys, TOMBSTONE_REF, type ArtifactStore } from "@naikan/baseline-store";

/** Enqueue a uicheck worker job for the given check id. Injected; no synchronous run. */
export type EnqueueUIRun = (checkId: string) => Promise<void>;

export interface UICheckAppOptions {
  auth: Auth;
  repo: ConfigRepo;
  /** Hands a "Run now" off to the worker queue (never runs Playwright inline). */
  enqueueUIRun: EnqueueUIRun;
  /**
   * Artifact store: read the manifest + presign artifacts for the UI, and — for
   * baseline promotion (#12) — copy run screenshots into the baseline subtree and
   * write the baseline manifest.
   */
  store: Pick<ArtifactStore, "get" | "put" | "copy" | "presignGet">;
  /**
   * Scoped bearer token for the regression-judge agent (`@naikan/mcp`). When set,
   * the agent may read runs + record verdicts; it never gains admin (run-now,
   * promote, CRUD stay session+admin only). Unset → reads are session-only.
   */
  agentToken?: string;
}

/** How long presigned screenshot URLs stay valid — long enough to render the page. */
const PRESIGN_TTL_SECONDS = 300;

/** One judged signal as recorded in the manifest (#13). */
interface ManifestSignal {
  kind: string;
  pass: boolean;
  severity: string;
  detail: string;
}

/** Shape of the per-run manifest the worker writes (issue #11b, diffs added #12, signals #13). */
interface RunManifest {
  runId: string;
  viewports: string[];
  screenshots: Record<string, string>;
  /** Per-viewport diff result, present once the check has a baseline (#12). */
  diffs?: Record<string, { pct: number; key?: string }>;
  /** Per-viewport judged signals (#13) — plain data, served as-is. */
  signals?: Record<string, ManifestSignal[]>;
}

export function createUICheckApp(opts: UICheckAppOptions) {
  const { auth, repo, enqueueUIRun, store, agentToken } = opts;
  const app = new Hono<AuthEnv>();

  // The agent token authenticates as a read-only `viewer` principal everywhere, so
  // it can read + record verdicts; the admin role gate (writes) returns 403, not 401
  // — recognized credential, insufficient role. Scoping is by ROLE, not by route.
  const read = [requireAuth(auth, { agentToken })] as const;
  const write = [requireAuth(auth, { agentToken }), requireRole("admin")] as const;

  const actorOf = (c: { get: (k: "user") => { id: string } }): Actor => ({ id: c.get("user").id });

  // ---- CRUD (nested under a site for create/list, flat for get/update/delete) ----
  app.get("/api/sites/:siteId/uichecks", ...read, async (c) => {
    const site = await repo.getSite(c.req.param("siteId"));
    // Manager scoping (#16): treat a site outside the user's portfolio as absent.
    if (!site || !(await projectGate(repo, c.get("user")))(site.projectId)) {
      return c.json({ error: "site not found" }, 404);
    }
    return c.json({ checks: await repo.listUIChecks(site.id) });
  });

  app.post("/api/sites/:siteId/uichecks", ...write, async (c) => {
    const site = await repo.getSite(c.req.param("siteId"));
    if (!site) return c.json({ error: "site not found" }, 404);
    const body = await readJson(c);
    return withValidation(c, async () => {
      const check = await repo.createUICheck(
        { ...body, siteId: site.id } as unknown as UICheckInput,
        actorOf(c),
      );
      return c.json({ check }, 201);
    });
  });

  // Discovery: the flat list of every UI check visible to the caller, so the
  // regression-judge agent (`@naikan/mcp`) has one call to enumerate runs to judge
  // (the per-site list above needs a siteId the agent doesn't yet know). Manager
  // scoping is applied here exactly as on every other read surface (#16): resolve
  // each check's site → project once (cached) and gate it through `projectGate`.
  app.get("/api/uichecks", ...read, async (c) => {
    const gate = await projectGate(repo, c.get("user"));
    const checks = await repo.listAllUIChecks();
    const projectOfSite = new Map<string, string | null>();
    const visible = [];
    for (const check of checks) {
      if (!projectOfSite.has(check.siteId)) {
        const site = await repo.getSite(check.siteId);
        projectOfSite.set(check.siteId, site?.projectId ?? null);
      }
      if (gate(projectOfSite.get(check.siteId))) visible.push(check);
    }
    return c.json({ checks: visible });
  });

  app.get("/api/uichecks/:id", ...read, async (c) => {
    const check = await repo.getUICheck(c.req.param("id"));
    if (!check) return c.json({ error: "check not found" }, 404);
    const site = await repo.getSite(check.siteId);
    if (!site || !(await projectGate(repo, c.get("user")))(site.projectId)) {
      return c.json({ error: "check not found" }, 404);
    }
    return c.json({ check });
  });

  app.patch("/api/uichecks/:id", ...write, async (c) => {
    const body = await readJson(c);
    return withValidation(c, async () => {
      const check = await repo.updateUICheck(
        c.req.param("id"),
        body as unknown as UICheckPatch,
        actorOf(c),
      );
      if (!check) return c.json({ error: "check not found" }, 404);
      return c.json({ check });
    });
  });

  app.delete("/api/uichecks/:id", ...write, async (c) => {
    const deleted = await repo.deleteUICheck(c.req.param("id"), actorOf(c));
    if (!deleted) return c.json({ error: "check not found" }, 404);
    return c.body(null, 204);
  });

  // ---- Run now (enqueue a worker job; NOT synchronous) ----
  app.post("/api/uichecks/:id/run", ...write, async (c) => {
    const check = await repo.getUICheck(c.req.param("id"));
    if (!check) return c.json({ error: "check not found" }, 404);
    await enqueueUIRun(check.id);
    return c.json({ enqueued: true }, 202);
  });

  app.get("/api/uichecks/:id/runs", ...read, async (c) => {
    const check = await repo.getUICheck(c.req.param("id"));
    if (!check) return c.json({ error: "check not found" }, 404);
    const site = await repo.getSite(check.siteId);
    if (!site || !(await projectGate(repo, c.get("user")))(site.projectId)) {
      return c.json({ error: "check not found" }, 404);
    }
    return c.json({ runs: await repo.listRuns(check.id) });
  });

  // Run detail: the run plus presigned URLs for each viewport screenshot, resolved
  // from the manifest the worker recorded. Reading the manifest (not the check's
  // current viewports[]) keeps a historical run correct after the check is edited.
  app.get("/api/uichecks/:id/runs/:runId", ...read, async (c) => {
    const check = await repo.getUICheck(c.req.param("id"));
    if (!check) return c.json({ error: "check not found" }, 404);
    const site = await repo.getSite(check.siteId);
    if (!site || !(await projectGate(repo, c.get("user")))(site.projectId)) {
      return c.json({ error: "check not found" }, 404);
    }
    const runId = c.req.param("runId");
    const run = (await repo.listRuns(check.id)).find((r) => r.id === runId);
    if (!run) return c.json({ error: "run not found" }, 404);

    const screenshots: Record<string, string> = {};
    // Per-viewport diff: the stored fraction plus a presigned URL for the overlay
    // (null when this run had no baseline to diff against, so no overlay exists).
    const diffs: Record<string, { pct: number; url: string | null }> = {};
    // Per-viewport judged signals (#13) — plain data, served straight from the
    // manifest (no presigning), so the detail page renders per-signal status.
    let signals: Record<string, ManifestSignal[]> = {};
    // The retention reaper (#17) deletes a run's artifacts and rewrites its
    // artifactsRef to TOMBSTONE_REF. Detect that sentinel up front so the UI shows
    // an "artifacts expired" placeholder — and skip the pointless store.get of a
    // key we know is gone.
    const expired = run.artifactsRef === TOMBSTONE_REF;
    if (run.artifactsRef && !expired) {
      // A missing/corrupt manifest (e.g. the run's artifacts were reaped, #17)
      // degrades to an empty set so the run still renders — not a 500.
      try {
        const manifest = JSON.parse((await store.get(run.artifactsRef)).toString()) as RunManifest;
        for (const [viewport, key] of Object.entries(manifest.screenshots)) {
          screenshots[viewport] = await store.presignGet(key, PRESIGN_TTL_SECONDS);
        }
        for (const [viewport, d] of Object.entries(manifest.diffs ?? {})) {
          diffs[viewport] = {
            pct: d.pct,
            url: d.key ? await store.presignGet(d.key, PRESIGN_TTL_SECONDS) : null,
          };
        }
        signals = manifest.signals ?? {};
      } catch {
        // leave screenshots + diffs + signals empty
      }
    }
    // The check's current approved baseline, presigned per viewport, so the UI can
    // render baseline | current | diff side by side. Empty until a run is promoted.
    const baseline: Record<string, string> = {};
    if (check.baselineImageRef) {
      try {
        const bm = JSON.parse((await store.get(check.baselineImageRef)).toString()) as {
          screenshots: Record<string, string>;
        };
        for (const [viewport, key] of Object.entries(bm.screenshots)) {
          baseline[viewport] = await store.presignGet(key, PRESIGN_TTL_SECONDS);
        }
      } catch {
        // missing/corrupt baseline manifest → no baseline panel, not a 500
      }
    }

    // The latest agent regression-judge verdict for this run (Naikan), or null —
    // rendered as a badge next to the human promote-to-baseline action.
    const verdict = await repo.getLatestVerdict(run.id);

    return c.json({ run, screenshots, diffs, baseline, signals, verdict, expired });
  });

  // ---- record an agent regression-judge verdict for a run (Naikan) ----
  // Written by the `@naikan/mcp` server (agent token) — or an admin — after judging
  // whether the run's visual diff is a real regression or noise. Advisory telemetry:
  // it never auto-promotes; the human promote-to-baseline below stays authoritative.
  // Read-level auth (so the scoped viewer agent qualifies) + the same project gate.
  app.post("/api/uichecks/:id/runs/:runId/verdict", ...read, async (c) => {
    const check = await repo.getUICheck(c.req.param("id"));
    if (!check) return c.json({ error: "check not found" }, 404);
    const site = await repo.getSite(check.siteId);
    if (!site || !(await projectGate(repo, c.get("user")))(site.projectId)) {
      return c.json({ error: "check not found" }, 404);
    }
    const runId = c.req.param("runId");
    const run = (await repo.listRuns(check.id)).find((r) => r.id === runId);
    if (!run) return c.json({ error: "run not found" }, 404);

    const body = await readJson(c);
    return withValidation(c, async () => {
      const verdict = await repo.recordVerdict({
        runId: run.id,
        verdict: body.verdict as never,
        confidence: typeof body.confidence === "number" ? body.confidence : null,
        reasoning: typeof body.reasoning === "string" ? body.reasoning : "",
        model: typeof body.model === "string" ? body.model : "",
      });
      return c.json({ verdict }, 201);
    });
  });

  // ---- promote a run to baseline (#12) ----
  // Copies the run's per-viewport screenshots into the baseline subtree (bytes
  // duplicated via the store's server-side copy — NOT re-pointed at run keys, so
  // the baseline survives the run's reaping), writes the baseline manifest, then
  // points the check at it and audits the promotion. Admin-only.
  app.post("/api/uichecks/:id/runs/:runId/promote", ...write, async (c) => {
    const check = await repo.getUICheck(c.req.param("id"));
    if (!check) return c.json({ error: "check not found" }, 404);
    const runId = c.req.param("runId");
    const run = (await repo.listRuns(check.id)).find((r) => r.id === runId);
    if (!run || !run.artifactsRef) return c.json({ error: "run not found" }, 404);

    const site = await repo.getSite(check.siteId);
    if (!site) return c.json({ error: "site not found" }, 404);
    const projectId = site.projectId;

    const manifest = JSON.parse((await store.get(run.artifactsRef)).toString()) as RunManifest;

    // Copy each viewport's screenshot into the baseline subtree.
    const baselineScreenshots: Record<string, string> = {};
    for (const [viewport, runKey] of Object.entries(manifest.screenshots)) {
      const baselineKey = artifactKeys.baseline(projectId, check.id, viewport);
      await store.copy(runKey, baselineKey);
      baselineScreenshots[viewport] = baselineKey;
    }

    // Record which run was promoted + the per-viewport baseline keys.
    const baselineManifestKey = artifactKeys.baselineManifest(projectId, check.id);
    await store.put(
      baselineManifestKey,
      Buffer.from(
        JSON.stringify({ promotedFromRunId: manifest.runId, screenshots: baselineScreenshots }),
      ),
      "application/json",
    );

    const updated = await repo.promoteUICheckBaseline(
      check.id,
      { baselineImageRef: baselineManifestKey, runId: manifest.runId },
      actorOf(c),
    );
    return c.json({ check: updated });
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
