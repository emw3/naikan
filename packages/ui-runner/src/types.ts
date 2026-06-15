/**
 * Types for `@naikan/ui-runner` — the domain layer over `@naikan/capture`.
 *
 * `runUI` maps a UICheck's viewports to capture sizes, drives `capture`, and
 * returns per-viewport screenshot artifacts, baseline diffs (#12), and judged
 * synthetic Signals (#13). It owns every judgment — `capture` makes none
 * (ADR-0006).
 *
 * Like `heartbeat-runner`, this is a pure executor: no S3, no DB. Side-effects
 * (the browser) are injected via `UIRunnerDeps`, defaulting to the live driver.
 */
import type { BrowserDriver, CaptureOptions, ConsoleMessage, NavObservation, PerfObservation } from "@naikan/capture";

/** A viewport a UICheck captures at. */
export interface Viewport {
  /** Stable label, used as the artifact/viewport key, e.g. `desktop`. */
  label: string;
  width: number;
  height: number;
}

/**
 * Per-signal severity (mirrors `config-repo`'s, kept local so the kernel layer
 * does not depend on the config layer). `critical` can page realtime (alerter,
 * #14); `warning` only contributes to the daily digest.
 */
export type Severity = "critical" | "warning";

/** The four synthetic signals a UI run judges (#13). */
export type SignalKind = "load" | "console" | "selector" | "perf";

/** Web-Vitals budget the perf signal is judged against (#13). */
export interface PerfBudget {
  /** Largest Contentful Paint budget, milliseconds. */
  lcpMs: number;
  /** Total transferred page weight budget, bytes. */
  pageWeightBytes: number;
  /** Maximum request count. */
  maxRequests: number;
}

/**
 * One judged synthetic signal for one viewport: a single dimension of a UI run's
 * health (#13). `pass` is the judgment, `severity` decides routing (critical
 * pages, warning digests), `detail` is the human-readable reason (esp. on fail).
 */
export interface Signal {
  kind: SignalKind;
  pass: boolean;
  severity: Severity;
  detail: string;
}

/** The four signals judged for one viewport. */
export interface ViewportSignals {
  /** Viewport label these signals were judged for. */
  viewport: string;
  signals: Signal[];
}

/** The raw observations one viewport's `judgeSignals` reads (a `CaptureResult` subset). */
export interface SignalInput {
  nav: NavObservation;
  console: ConsoleMessage[];
  perf: PerfObservation;
  selectorsPresent: Record<string, boolean>;
}

/** Resolved judgment inputs for `judgeSignals` — what the signals are scored against. */
export interface SignalJudgeConfig {
  /** Required selectors the selector signal checks (empty → passes vacuously). */
  selectors: string[];
  /** Budget the perf signal compares observations to. */
  perfBudget: PerfBudget;
  /** Severity per signal kind. */
  severities: Record<SignalKind, Severity>;
}

/** The subset of a UICheck the runner needs to execute one run. */
export interface UIRunConfig {
  /** Absolute URL of the page to capture. */
  url: string;
  /** Viewports to capture at. */
  viewports: Viewport[];
  /** CSS selectors masked before diffing — `UICheck.ignoreRegions` (#12). */
  ignoreRegions?: string[];
  /** Pixel-diff fail threshold as a fraction 0..1 — `UICheck.diffThreshold` (#12). */
  diffThreshold?: number;
  /** Required selectors for the selector signal — `UICheck.selectors` (#13). */
  selectors?: string[];
  /** Perf budget for the perf signal — `UICheck.perfBudget` (#13). */
  perfBudget?: PerfBudget;
  /** Per-signal severities (#13). Defaults: load=critical, others=warning. */
  severities?: Partial<Record<SignalKind, Severity>>;
}

/**
 * Approved baseline screenshots to diff against, keyed by viewport label.
 * Used by `runUI` when diffing (#12).
 */
export interface Baseline {
  screenshots: Record<string, Buffer>;
}

/** A per-viewport screenshot artifact — plain data, no S3/DB reference. */
export interface Artifact {
  /** Viewport label this screenshot was captured at. */
  viewport: string;
  screenshot: Buffer;
  dims: { w: number; h: number };
}

/**
 * Per-viewport result of diffing a run's screenshot against the approved baseline
 * (#12). Emitted only for viewports the baseline actually has a screenshot for.
 */
export interface Diff {
  /** Viewport label this diff is for. */
  viewport: string;
  /** Differing-pixel fraction, 0..1 (1 on a dimension mismatch). */
  pct: number;
  /** True when `pct` exceeded the check's `diffThreshold`, or dimensions mismatched. */
  regressed: boolean;
  /** True when run dims differed from the baseline; diffing was skipped (#12). */
  dimensionMismatch: boolean;
  /** Diff overlay PNG. Absent on a dimension mismatch (nothing to overlay). */
  diff?: Buffer;
}

/** Outcome of one UI run. */
export interface UIRunResult {
  /** Per-viewport judged signals (#13). */
  signals: ViewportSignals[];
  /** One screenshot artifact per configured viewport. */
  artifacts: Artifact[];
  /** Per-viewport baseline diffs (#12). Empty when the check has no baseline yet. */
  diffs: Diff[];
}

/** Injectable side-effects. Defaults to the live Playwright driver. */
export interface UIRunnerDeps {
  /** Browser seam, passed through to `capture`. Defaults to the live driver. */
  driver?: BrowserDriver;
  /** Determinism tuning passed through to `capture`. */
  captureOptions?: Pick<CaptureOptions, "settleMs" | "navigationTimeoutMs">;
}
