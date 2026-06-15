/** Public surface of `@naikan/ui-runner`. */
export type {
  Artifact,
  Baseline,
  Diff,
  PerfBudget,
  Severity,
  Signal,
  SignalInput,
  SignalJudgeConfig,
  SignalKind,
  UIRunConfig,
  UIRunnerDeps,
  UIRunResult,
  Viewport,
  ViewportSignals,
} from "./types.ts";
export { runUI } from "./runner.ts";
export { judgeSignals } from "./signals.ts";
export { diffScreenshots, type DiffOutcome } from "./diff.ts";
export { VIEWPORTS, resolveViewports } from "./viewports.ts";
