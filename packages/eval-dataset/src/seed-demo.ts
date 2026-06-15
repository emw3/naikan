/**
 * Live-stack demo seed (issue #05). Reuses the synthetic seed cases to leave a
 * running Naikan stack holding a Project an agent can judge live: one UI check per
 * case, each with a promoted Baseline and a current run whose Diff is a genuine
 * `real_regression`, `noise`, or `intentional` change — captured through the real
 * pipeline, not mocked.
 *
 * Node-only (drives Playwright via ui-runner → capture; talks to Postgres + S3).
 * Needs a reachable stack — the same env the worker uses:
 *
 *   DATABASE_URL=… S3_ENDPOINT=… S3_BUCKET=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
 *     node packages/eval-dataset/src/seed-demo.ts
 *   # against a `bun stack up` worktree:  bun run eval:seed-demo
 *
 * Idempotent: drops any prior "Naikan Demo" project, its (polymorphic, non-FK)
 * check runs, and its S3 artifacts before recreating, so it re-runs cleanly.
 *
 * The persistence mirrors `apps/worker/src/ui-job.ts` (`runUIJob`) and the promote
 * route in `apps/api/src/uicheck/routes.ts`, built on the same `artifactKeys` +
 * `ArtifactStore` + `ConfigRepo` primitives — but drives two distinct URLs
 * (baseline vs current state) directly, which the single-path worker cannot. The
 * runner + sql purge are injected so `seedDemo` is testable without a browser or DB
 * (see `seed-demo.test.ts`); `main` wires the live Postgres + S3 + Playwright.
 */
import { runUI as liveRunUI, resolveViewports, type Baseline, type UIRunResult } from "@naikan/ui-runner";
import {
  createConfigRepo,
  createPgConfigStore,
  type Actor,
  type CheckRun,
  type ConfigRepo,
  type Site,
  type UICheck,
} from "@naikan/config-repo";
import { artifactKeys, configFromEnv, createArtifactStore, type ArtifactStore } from "@naikan/baseline-store";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { SEED_CASES, type SeedCase } from "./cases.ts";
import { pageUrl, startSeedServer, type SeedServer } from "./server.ts";

const PROJECT_NAME = "Naikan Demo";
/** System actor — null user_id, recorded as a system action in the audit log. */
const SYSTEM: Actor = { id: null };
/** The demo captures a single viewport so the run detail reads cleanly. */
const VIEWPORT = "desktop";
/** Threshold 0 so every demo run records a Diff for the agent to judge, even noise. */
const DIFF_THRESHOLD = 0;

/** The runner seam — defaults to the live Playwright-backed `runUI`. */
export type RunUIFn = (config: Parameters<typeof liveRunUI>[0], baseline?: Baseline) => Promise<UIRunResult>;

/** What `seedDemo` needs: a repo + a put-only artifact sink. */
export interface SeedDeps {
  repo: ConfigRepo;
  store: Pick<ArtifactStore, "put">;
}

/** One judged signal flattened to the manifest's plain shape. */
interface ManifestSignal {
  kind: string;
  pass: boolean;
  severity: string;
  detail: string;
}

/**
 * Persist a `UIRunResult` as a CheckRun (screenshots + diffs + manifest in S3, the
 * run row in Postgres). Mirrors `runUIJob`'s persistence + status logic.
 */
async function persistRun(
  deps: SeedDeps,
  projectId: string,
  check: UICheck,
  result: UIRunResult,
  runId: string,
  startedAt: Date,
): Promise<CheckRun> {
  const { store, repo } = deps;

  const screenshots: Record<string, string> = {};
  for (const a of result.artifacts) {
    const key = artifactKeys.runScreenshot(projectId, check.id, runId, a.viewport);
    await store.put(key, a.screenshot, "image/png");
    screenshots[a.viewport] = key;
  }

  const diffs: Record<string, { pct: number; key?: string }> = {};
  for (const d of result.diffs) {
    if (d.diff) {
      const key = artifactKeys.runDiff(projectId, check.id, runId, d.viewport);
      await store.put(key, d.diff, "image/png");
      diffs[d.viewport] = { pct: d.pct, key };
    } else {
      diffs[d.viewport] = { pct: d.pct };
    }
  }

  const signals: Record<string, ManifestSignal[]> = {};
  for (const vp of result.signals) {
    signals[vp.viewport] = vp.signals.map((s) => ({
      kind: s.kind,
      pass: s.pass,
      severity: s.severity,
      detail: s.detail,
    }));
  }

  const manifest = {
    runId,
    viewports: result.artifacts.map((a) => a.viewport),
    screenshots,
    ...(result.diffs.length > 0 ? { diffs } : {}),
    ...(result.signals.length > 0 ? { signals } : {}),
  };
  const manifestKey = artifactKeys.runManifest(projectId, check.id, runId);
  await store.put(manifestKey, Buffer.from(JSON.stringify(manifest)), "application/json");

  const regressed = result.diffs.some((d) => d.regressed);
  const signalsFailed = result.signals.some((vp) => vp.signals.some((s) => !s.pass));
  const criticalFailed = result.signals.some((vp) =>
    vp.signals.some((s) => s.severity === "critical" && !s.pass),
  );
  const regressedViewports = result.diffs.filter((d) => d.regressed).map((d) => d.viewport);
  const error = regressedViewports.length > 0 ? `visual regression: ${regressedViewports.join(", ")}` : null;
  const finishedAt = new Date(startedAt.getTime() + 1000);

  return repo.recordRun({
    checkId: check.id,
    checkType: "uicheck",
    startedAt,
    finishedAt,
    status: regressed || signalsFailed ? "fail" : "pass",
    latencyMs: 1000,
    error,
    artifactsRef: manifestKey,
    criticalFailed,
  });
}

/**
 * Promote a baseline-state run's screenshots into the check's baseline subtree and
 * point the check at them. Mirrors the promote route, but writes the baseline bytes
 * straight from the in-memory capture rather than a server-side copy.
 */
async function promoteBaseline(
  deps: SeedDeps,
  projectId: string,
  check: UICheck,
  result: UIRunResult,
  fromRunId: string,
): Promise<void> {
  const { store, repo } = deps;
  const baselineScreenshots: Record<string, string> = {};
  for (const a of result.artifacts) {
    const key = artifactKeys.baseline(projectId, check.id, a.viewport);
    await store.put(key, a.screenshot, "image/png");
    baselineScreenshots[a.viewport] = key;
  }
  const manifestKey = artifactKeys.baselineManifest(projectId, check.id);
  await store.put(
    manifestKey,
    Buffer.from(JSON.stringify({ promotedFromRunId: fromRunId, screenshots: baselineScreenshots })),
    "application/json",
  );
  await repo.promoteUICheckBaseline(check.id, { baselineImageRef: manifestKey, runId: fromRunId }, SYSTEM);
}

/** Logger seam — defaults to stdout; tests pass a no-op to keep output clean. */
export type Log = (msg: string) => void;

/** Seed one case end-to-end: baseline run → promote → current diff run. */
async function seedCase(
  deps: SeedDeps,
  origin: string,
  projectId: string,
  site: Site,
  c: SeedCase,
  runUI: RunUIFn,
  log: Log,
): Promise<string> {
  const [viewport] = resolveViewports([VIEWPORT]);

  const check = await deps.repo.createUICheck(
    { siteId: site.id, path: `/${c.page}`, viewports: [VIEWPORT], diffThreshold: DIFF_THRESHOLD },
    SYSTEM,
  );

  // Baseline state → record run, then promote it as the approved baseline.
  const baselineRun = await runUI({
    url: pageUrl(origin, c.page, c.baselineQuery),
    viewports: [viewport],
    diffThreshold: DIFF_THRESHOLD,
  });
  const baselineRunId = crypto.randomUUID();
  await persistRun(deps, projectId, check, baselineRun, baselineRunId, new Date(Date.now() - 60_000));
  await promoteBaseline(deps, projectId, check, baselineRun, baselineRunId);

  // Current state → diff against the just-promoted baseline → the run an agent judges.
  const baseline: Baseline = { screenshots: { [viewport.label]: baselineRun.artifacts[0].screenshot } };
  const currentRun = await runUI(
    { url: pageUrl(origin, c.page, c.currentQuery), viewports: [viewport], diffThreshold: DIFF_THRESHOLD },
    baseline,
  );
  const run = await persistRun(deps, projectId, check, currentRun, crypto.randomUUID(), new Date());
  const pct = currentRun.diffs[0]?.pct ?? 0;
  log(`  ${c.id.padEnd(16)} ${c.label.padEnd(16)} diff ${(pct * 100).toFixed(3)}%  run ${run.id}`);
  return check.id;
}

export interface SeedResult {
  projectId: string;
  checkIds: string[];
}

/**
 * Create the demo Project + Site + one seeded UI check per case. Caller is
 * responsible for cleaning up any prior demo first (see `cleanup`). The runner is
 * injected; defaults to the live `runUI`.
 */
export async function seedDemo(
  deps: SeedDeps,
  origin: string,
  runUI: RunUIFn = liveRunUI,
  log: Log = console.log,
): Promise<SeedResult> {
  const project = await deps.repo.createProject({ name: PROJECT_NAME, contacts: "demo@naikan.dev" }, SYSTEM);
  const site = await deps.repo.createSite({ projectId: project.id, baseUrl: origin }, SYSTEM);
  log(`seeding "${PROJECT_NAME}" (${project.id}) → ${SEED_CASES.length} UI checks\n`);

  const checkIds: string[] = [];
  for (const c of SEED_CASES) {
    checkIds.push(await seedCase(deps, origin, project.id, site, c, runUI, log));
  }
  return { projectId: project.id, checkIds };
}

/**
 * Drop a prior demo project + its (non-FK, orphan-prone) runs + its S3 artifacts.
 * `purgeRuns` deletes the polymorphic check_runs the project cascade leaves behind
 * (sql-backed in `main`); the store purge clears the project's artifact prefix.
 */
export async function cleanup(
  repo: ConfigRepo,
  store: Pick<ArtifactStore, "list" | "delete">,
  purgeRuns: (checkIds: string[]) => Promise<void>,
): Promise<void> {
  const existing = (await repo.listProjects()).find((p) => p.name === PROJECT_NAME);
  if (!existing) return;

  const checkIds: string[] = [];
  for (const site of await repo.listSites(existing.id)) {
    for (const check of await repo.listUIChecks(site.id)) checkIds.push(check.id);
  }
  if (checkIds.length > 0) await purgeRuns(checkIds);
  await repo.deleteProject(existing.id, SYSTEM);

  const keys = await store.list(artifactKeys.projectPrefix(existing.id));
  for (const key of keys) await store.delete(key);
  console.log(`cleaned prior "${PROJECT_NAME}" (${checkIds.length} checks, ${keys.length} artifacts)`);
}

async function main(): Promise<void> {
  const store = createArtifactStore(configFromEnv());
  await store.ensureBucket();
  const sql = postgres(requireEnv("DATABASE_URL"));
  const repo = createConfigRepo(createPgConfigStore(() => sql));

  const server: SeedServer = await startSeedServer();
  try {
    // check_runs are polymorphic (not FK'd to checks), so the project-delete
    // cascade orphans them — purge by check id explicitly.
    await cleanup(repo, store, async (checkIds) => {
      await sql`delete from check_runs where check_id = any(${sql.array(checkIds)})`;
    });

    await seedDemo({ repo, store }, server.origin, liveRunUI);

    console.log(`\n✓ demo seeded. Open the app, project "${PROJECT_NAME}", judge the latest run of each check.`);
    console.log(`  Note: the seed page server (${server.origin}) is ephemeral — "Run now" needs it re-served;`);
    console.log(`  the pre-seeded runs an agent judges are already frozen in storage.`);
  } finally {
    await server.close();
    await sql.end({ timeout: 5 });
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`seed-demo: missing required env var ${name}`);
  return v;
}

// Only run the live seed when executed directly (not when imported by the test).
// `import.meta.main` is unavailable on Node 22, so compare the entrypoint instead.
const isEntrypoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  main().catch((err) => {
    console.error("eval:seed-demo FAILED —", err);
    process.exit(1);
  });
}
