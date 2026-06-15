/** Public surface of `@naikan/eval-dataset` — the labeled golden corpus (#05) + eval harness (#06). */
export { loadDataset, DEFAULT_DATASET_ROOT } from "./load.ts";
export { LABELS } from "./types.ts";
export type {
  DatasetManifest,
  Fixture,
  FixtureSignal,
  FixtureSource,
  Label,
  ManifestFixture,
} from "./types.ts";

// Eval harness (#06): score a judge over the labeled dataset.
export { runEval } from "./eval.ts";
export type { EvalReport, EvalResult, Judge, JudgeOutput, Misjudge } from "./eval.ts";
export { computeMetrics } from "./grade.ts";
export type { Confusion, LabelMetrics, Metrics } from "./grade.ts";

// Model-backed judge under test (#06): gated on a reachable model.
export { createClaudeJudge, isModelAvailable, DEFAULT_JUDGE_MODEL } from "./judge.ts";
export type { ClaudeJudgeOptions } from "./judge.ts";
