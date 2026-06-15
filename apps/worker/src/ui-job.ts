/**
 * UI-check job handler — the unit the worker runs for each enqueued uicheck job.
 *
 * It loads the UI check and its site, drives the (injectable) `runUI` against the
 * site base URL + check path, persists the per-viewport screenshots and a per-run
 * `manifest.json` via `@naikan/baseline-store`, and records a `CheckRun`
 * (`check_type='uicheck'`) whose `artifactsRef` is the manifest key. Mirrors
 * `runHeartbeatJob`, differing in that it produces artifacts.
 *
 * This slice produces screenshots only — no baseline/diff (#12), no signals (#13)
 * — so a completed capture is recorded as a `pass`. The manifest is the source of
 * truth for what a historical run produced, so a run renders correctly even if the
 * check's `viewports[]` is edited afterwards.
 *
 * `runUI`, the artifact store, the clock, and the run-id generator are injected so
 * the handler is testable without a real browser or S3.
 */
import {
  runUI as liveRunUI,
  resolveViewports,
  type Baseline,
  type UIRunConfig,
  type UIRunResult,
  type UIRunnerDeps,
} from "@naikan/ui-runner";
import { artifactKeys, type ArtifactStore } from "@naikan/baseline-store";
import { applyUIIncidentForRun, type CheckRun, type ConfigRepo } from "@naikan/config-repo";
import type { IncidentAlertEvent } from "@naikan/alerter";

/** Executes one UI check. Defaults to the live Playwright-backed `runUI`. */
export type RunUI = (
  config: UIRunConfig,
  baseline?: Baseline,
  deps?: UIRunnerDeps,
) => Promise<UIRunResult>;

export interface RunUIJobDeps {
  repo: ConfigRepo;
  /**
   * Artifact sink + source: `put` for screenshots, diffs, and the manifest; `get`
   * to load the approved baseline a run diffs against (#12).
   */
  store: Pick<ArtifactStore, "put" | "get">;
  /** Override the runner in tests; defaults to the real `runUI`. */
  runUI?: RunUI;
  /** Run-id generator (partitions the run's artifact subtree); defaults to a UUID. */
  genId?: () => string;
  /** Clock, injectable for deterministic tests. */
  now?: () => Date;
  /**
   * Optional incident-alert sink (#14). After the CheckRun is recorded, a
   * critical-signal failure drives the same incident machine as heartbeats; a
   * transition that opens/closes an incident is dispatched through this callback.
   * Omitted → incidents transition silently (e.g. "Run now" with no alerter wired).
   */
  alerter?: (event: IncidentAlertEvent) => Promise<void>;
}

/** Body of the baseline manifest a promotion writes (#12); read here to load it. */
interface BaselineManifest {
  promotedFromRunId: string;
  /** Per-viewport approved-baseline artifact key. */
  screenshots: Record<string, string>;
}

/** One judged signal as recorded in the manifest (#13) — plain JSON, no buffers. */
interface ManifestSignal {
  kind: string;
  pass: boolean;
  severity: string;
  detail: string;
}

/**
 * Body of the per-run `manifest.json` (issue #11b): what the run produced. #12
 * adds `diffs`, #13 adds `signals` to this same object. A diff carries the
 * differing-pixel fraction and, when an overlay was produced, its artifact key
 * (absent on a dimension mismatch, where there is nothing to overlay). `signals`
 * is the per-viewport judged signal set, so the detail page renders per-viewport
 * per-signal status without recomputing.
 */
export interface RunManifest {
  runId: string;
  /** Viewport labels actually captured, in capture order. */
  viewports: string[];
  /** Per-viewport screenshot artifact key. */
  screenshots: Record<string, string>;
  /** Per-viewport baseline diff, present once the check has a baseline (#12). */
  diffs?: Record<string, { pct: number; key?: string }>;
  /** Per-viewport judged signals (#13), present once any viewport was captured. */
  signals?: Record<string, ManifestSignal[]>;
}

/**
 * Run one UI check: capture, persist artifacts + manifest, record the CheckRun.
 * Returns the recorded run, or null when the check (or its site) no longer exists
 * — a check deleted between enqueue and execution is a no-op, not an error.
 */
export async function runUIJob(checkId: string, deps: RunUIJobDeps): Promise<CheckRun | null> {
  const { repo, store } = deps;
  const runUI = deps.runUI ?? liveRunUI;
  const genId = deps.genId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => new Date());

  const check = await repo.getUICheck(checkId);
  if (!check) return null;
  const site = await repo.getSite(check.siteId);
  if (!site) return null;

  // Load the approved baseline (if any) so the runner can diff against it. A check
  // with no promoted baseline yet diffs nothing — its first runs only capture.
  const baseline = await loadBaseline(store, check.baselineImageRef);

  const runId = genId();
  const startedAt = now();
  const url = new URL(check.path, site.baseUrl).toString();
  const result = await runUI(
    {
      url,
      viewports: resolveViewports(check.viewports),
      ignoreRegions: check.ignoreRegions,
      diffThreshold: check.diffThreshold,
      // Signal inputs (#13): required selectors, perf budget, and the per-signal
      // severities that decide routing (critical pages, warning digests — #14).
      selectors: check.selectors,
      perfBudget: check.perfBudget,
      severities: {
        load: check.severityLoad,
        console: check.severityConsole,
        selector: check.severitySelector,
        perf: check.severityPerf,
      },
    },
    baseline,
  );
  const finishedAt = now();

  // Persist one screenshot per captured viewport, recording its key for the manifest.
  const screenshots: Record<string, string> = {};
  for (const artifact of result.artifacts) {
    const key = artifactKeys.runScreenshot(site.projectId, check.id, runId, artifact.viewport);
    await store.put(key, artifact.screenshot, "image/png");
    screenshots[artifact.viewport] = key;
  }

  // Persist each diff overlay (none exists on a dimension mismatch) and record the
  // per-viewport pct + overlay key. Any regressed viewport fails the run.
  const diffs: Record<string, { pct: number; key?: string }> = {};
  for (const diff of result.diffs) {
    if (diff.diff) {
      const key = artifactKeys.runDiff(site.projectId, check.id, runId, diff.viewport);
      await store.put(key, diff.diff, "image/png");
      diffs[diff.viewport] = { pct: diff.pct, key };
    } else {
      diffs[diff.viewport] = { pct: diff.pct };
    }
  }
  const regressed = result.diffs.some((d) => d.regressed);

  // Record the judged signals per viewport so the detail page renders them
  // without recomputing. A run fails if any signal failed (regardless of
  // severity — severity only decides alert routing, #14) or any viewport regressed.
  const signals: Record<string, ManifestSignal[]> = {};
  for (const vp of result.signals) {
    signals[vp.viewport] = vp.signals.map((s) => ({
      kind: s.kind,
      pass: s.pass,
      severity: s.severity,
      detail: s.detail,
    }));
  }
  const signalsFailed = result.signals.some((vp) => vp.signals.some((s) => !s.pass));

  // Incident gating (#14): a run is incident-relevant-failed iff a *critical*
  // signal failed — distinct from `status`, which fails on any signal/regression
  // (digest). Visual regression defaults to a warning and never pages, so it is
  // not part of this predicate.
  const criticalFailed = result.signals.some((vp) =>
    vp.signals.some((s) => s.severity === "critical" && !s.pass),
  );

  // Human failure summary (de-duplicated across viewports): every failing signal,
  // plus any regressed viewports. Non-null exactly when the run failed, so it
  // doubles as the alert's error line on a critical failure.
  const failingSignals = [
    ...new Set(
      result.signals.flatMap((vp) =>
        vp.signals.filter((s) => !s.pass).map((s) => `${s.kind}: ${s.detail}`),
      ),
    ),
  ];
  const regressedViewports = result.diffs.filter((d) => d.regressed).map((d) => d.viewport);
  if (regressedViewports.length > 0) {
    failingSignals.push(`visual regression: ${regressedViewports.join(", ")}`);
  }
  const error = failingSignals.length > 0 ? failingSignals.join("; ") : null;

  const manifest: RunManifest = {
    runId,
    viewports: result.artifacts.map((a) => a.viewport),
    screenshots,
    ...(result.diffs.length > 0 ? { diffs } : {}),
    ...(result.signals.length > 0 ? { signals } : {}),
  };
  const manifestKey = artifactKeys.runManifest(site.projectId, check.id, runId);
  await store.put(manifestKey, Buffer.from(JSON.stringify(manifest)), "application/json");

  const run = await repo.recordRun({
    checkId: check.id,
    checkType: "uicheck",
    startedAt,
    finishedAt,
    status: regressed || signalsFailed ? "fail" : "pass",
    latencyMs: finishedAt.getTime() - startedAt.getTime(),
    error,
    artifactsRef: manifestKey,
    criticalFailed,
  });

  // Resolve incident state off the same machine heartbeats use, gated on the
  // critical-fail history (#14). Best-effort alerting — never fails the job.
  await applyUIIncidentForRun({ repo, checkId: check.id, alerter: deps.alerter });

  return run;
}

/**
 * Resolve a check's `baselineImageRef` into in-memory baseline screenshots for the
 * runner. Returns undefined when the check has no baseline. A missing/corrupt
 * baseline manifest degrades to no baseline (the run captures without diffing)
 * rather than failing the whole job.
 */
async function loadBaseline(
  store: Pick<ArtifactStore, "get">,
  baselineImageRef: string | null,
): Promise<Baseline | undefined> {
  if (!baselineImageRef) return undefined;
  try {
    const manifest = JSON.parse((await store.get(baselineImageRef)).toString()) as BaselineManifest;
    const screenshots: Record<string, Buffer> = {};
    for (const [viewport, key] of Object.entries(manifest.screenshots)) {
      screenshots[viewport] = await store.get(key);
    }
    return { screenshots };
  } catch {
    return undefined;
  }
}
