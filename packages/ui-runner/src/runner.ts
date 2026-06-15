/**
 * `@naikan/ui-runner` — pure executor for a UICheck (issues #11a, #12, #13).
 *
 * Maps the check's viewports to capture sizes, drives `@naikan/capture`, and
 * returns per viewport: one screenshot artifact, a masked pixel-diff when a
 * baseline is supplied (#12), and the four judged synthetic Signals (#13). No S3,
 * no DB: side-effects (the browser) and the baseline screenshots are injected,
 * mirroring `heartbeat-runner`. Loading the baseline from storage is the worker's
 * job; this stays pure.
 *
 * Capture returns raw observations and makes no judgment; this layer turns them
 * into Signals via `judgeSignals` (ADR-0006).
 */
import { capture, type Size } from "@naikan/capture";
import { diffScreenshots } from "./diff.ts";
import { judgeSignals } from "./signals.ts";
import type {
  Artifact,
  Baseline,
  Diff,
  PerfBudget,
  Severity,
  SignalKind,
  UIRunConfig,
  UIRunResult,
  UIRunnerDeps,
  ViewportSignals,
} from "./types.ts";

/** PRD perf budget — applied when the check supplies none (LCP 2.5s, 3 MB, 100 reqs). */
const DEFAULT_PERF_BUDGET: PerfBudget = { lcpMs: 2500, pageWeightBytes: 3 * 1024 * 1024, maxRequests: 100 };
/** PRD per-signal severity defaults: load pages, the rest only digest. */
const DEFAULT_SEVERITIES: Record<SignalKind, Severity> = {
  load: "critical",
  console: "warning",
  selector: "warning",
  perf: "warning",
};

export async function runUI(
  config: UIRunConfig,
  baseline?: Baseline,
  deps: UIRunnerDeps = {},
): Promise<UIRunResult> {
  const sizes: Size[] = config.viewports.map((v) => ({
    label: v.label,
    width: v.width,
    height: v.height,
  }));

  const selectors = config.selectors ?? [];
  const results = await capture(config.url, sizes, {
    driver: deps.driver,
    settleMs: deps.captureOptions?.settleMs,
    navigationTimeoutMs: deps.captureOptions?.navigationTimeoutMs,
    // `ignore_regions` reach the browser as mask selectors; their bounding boxes
    // come back on each result and are painted before diffing (ADR-0006).
    maskSelectors: config.ignoreRegions ?? [],
    // Required selectors reach the browser as presence probes (judgment-free);
    // the selector signal decides "all present" here.
    selectors,
  });

  const artifacts: Artifact[] = results.map((r) => ({
    viewport: r.label,
    screenshot: r.screenshot,
    dims: r.dims,
  }));

  // Judge the four signals per viewport from each capture's raw observations.
  const judgeConfig = {
    selectors,
    perfBudget: config.perfBudget ?? DEFAULT_PERF_BUDGET,
    severities: { ...DEFAULT_SEVERITIES, ...config.severities },
  };
  const signals: ViewportSignals[] = results.map((r) => ({
    viewport: r.label,
    signals: judgeSignals(
      { nav: r.nav, console: r.console, perf: r.perf, selectorsPresent: r.selectorsPresent },
      judgeConfig,
    ),
  }));

  // Diff only the viewports the baseline actually covers. A run before any
  // baseline (or a newly-added viewport) simply produces no diff for it.
  const diffs: Diff[] = [];
  if (baseline) {
    const threshold = config.diffThreshold ?? 0;
    for (const r of results) {
      const baselineShot = baseline.screenshots[r.label];
      if (!baselineShot) continue;
      const outcome = diffScreenshots(baselineShot, r.screenshot, r.masks);
      diffs.push({
        viewport: r.label,
        pct: outcome.pct,
        regressed: outcome.dimensionMismatch || outcome.pct > threshold,
        dimensionMismatch: outcome.dimensionMismatch,
        diff: outcome.diff,
      });
    }
  }

  return { signals, artifacts, diffs };
}
