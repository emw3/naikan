/**
 * `runEval(dataset, judge)` — the eval harness (issue #06).
 *
 * Runs a **judge** over the labeled golden corpus and scores its verdicts against
 * ground truth, returning accuracy, per-label precision/recall, a confusion matrix
 * over the four verdict kinds, and the list of misjudged cases (predicted vs.
 * expected + the fixture reference + the judge's reasoning, retained for inspection).
 *
 * The judge is **injected** — this is the seam the slice is built around. In the
 * unit tests it is a pure lookup table (deterministic, no model); the regression
 * test passes the real model-backed `claudeJudge` from `judge.ts`. `runEval` itself
 * never touches a model or reads an image: it orchestrates and grades, nothing more.
 *
 * Fixtures are judged **sequentially** — the model-backed judge is rate-limited and
 * order-stable scoring keeps the misjudged list reproducible run-to-run.
 */
import { computeMetrics, type Confusion, type LabelMetrics } from "./grade.ts";
import type { Fixture, FixtureSource, Label } from "./types.ts";

/** What a judge returns for one fixture: a verdict, optional confidence + reasoning. */
export interface JudgeOutput {
  verdict: Label;
  /** Self-reported 0..1; surfaced in misjudged cases to flag low-confidence errors. */
  confidence?: number;
  /** Plain-language justification, retained on every result for inspection. */
  reasoning?: string;
}

/** A judge classifies one fixture. Sync (fake) or async (model-backed). */
export type Judge = (fixture: Fixture) => JudgeOutput | Promise<JudgeOutput>;

/** One fixture's scored outcome. */
export interface EvalResult {
  id: string;
  source: FixtureSource;
  expected: Label;
  predicted: Label;
  correct: boolean;
  confidence?: number;
  reasoning?: string;
}

/** A case the judge got wrong — predicted vs. expected, with reasoning retained. */
export interface Misjudge {
  id: string;
  source: FixtureSource;
  expected: Label;
  predicted: Label;
  confidence?: number;
  reasoning?: string;
}

/** The full eval report: metric math + the per-fixture trail. */
export interface EvalReport {
  total: number;
  correct: number;
  accuracy: number;
  macroPrecision: number;
  macroRecall: number;
  macroF1: number;
  byLabel: Record<Label, LabelMetrics>;
  confusion: Confusion;
  /** One entry per fixture, in dataset order. */
  results: EvalResult[];
  /** The subset of `results` the judge got wrong. */
  misjudged: Misjudge[];
}

/** Run `judge` over `dataset`, scoring each verdict against its ground-truth label. */
export async function runEval(dataset: Fixture[], judge: Judge): Promise<EvalReport> {
  const results: EvalResult[] = [];
  for (const fixture of dataset) {
    const out = await judge(fixture);
    results.push({
      id: fixture.id,
      source: fixture.source,
      expected: fixture.label,
      predicted: out.verdict,
      correct: out.verdict === fixture.label,
      confidence: out.confidence,
      reasoning: out.reasoning,
    });
  }

  const metrics = computeMetrics(results.map((r) => ({ expected: r.expected, predicted: r.predicted })));
  const misjudged: Misjudge[] = results
    .filter((r) => !r.correct)
    .map(({ id, source, expected, predicted, confidence, reasoning }) => ({
      id,
      source,
      expected,
      predicted,
      confidence,
      reasoning,
    }));

  return { ...metrics, results, misjudged };
}
