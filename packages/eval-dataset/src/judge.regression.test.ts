/**
 * Eval regression test (issue #06) — the accuracy guard for the regression judge.
 *
 * Two layers:
 *  1. An **always-run** wiring check: `runEval` over the *real* committed golden
 *     dataset with deterministic fake judges. Proves `loadDataset` ↔ `runEval`
 *     integrate (the dataset parses, grades, and collects misjudges) on every
 *     `bun test`, with no model.
 *  2. A **model-gated** threshold check: the real `claudeJudge` over the golden
 *     dataset, asserting accuracy ≥ {@link ACCURACY_THRESHOLD}. It runs only where a
 *     model is reachable (`isModelAvailable()`); elsewhere it is **skipped**, never
 *     silently passed — `bun test` reports it as skipped.
 *
 * The threshold is the documented bar: a prompt or model change that drops judge
 * accuracy on the golden set below it fails CI. See `EVALS.md` for the measured
 * numbers behind this bar.
 */
import { describe, expect, test } from "bun:test";
import { loadDataset } from "./load.ts";
import { runEval, type Judge } from "./eval.ts";
import { createClaudeJudge, isModelAvailable } from "./judge.ts";

/**
 * Documented accuracy bar for the judge on the golden dataset. Set below the measured
 * accuracy (see `EVALS.md`) so normal model variance doesn't flake CI, but high enough
 * that a real regression in judging quality trips it.
 */
export const ACCURACY_THRESHOLD = 0.7;

describe("eval harness over the committed golden dataset (no model)", () => {
  const dataset = loadDataset();

  test("the golden dataset loads and is non-trivially sized", () => {
    expect(dataset.length).toBeGreaterThanOrEqual(9);
  });

  test("a perfect judge scores accuracy 1 over the real dataset", async () => {
    const perfect: Judge = (f) => ({ verdict: f.label });
    const report = await runEval(dataset, perfect);
    expect(report.accuracy).toBe(1);
    expect(report.misjudged).toEqual([]);
    expect(report.total).toBe(dataset.length);
  });

  test("a constant judge's misjudges are collected from the real dataset", async () => {
    const alwaysRegression: Judge = () => ({ verdict: "real_regression" });
    const report = await runEval(dataset, alwaysRegression);
    // Every non-real_regression fixture is a misjudge; counts must reconcile.
    const expectedMisses = dataset.filter((f) => f.label !== "real_regression").length;
    expect(report.misjudged.length).toBe(expectedMisses);
    expect(report.correct).toBe(dataset.length - expectedMisses);
  });
});

describe("regression judge accuracy on the golden dataset (model-gated)", () => {
  const run = isModelAvailable();
  if (!run) {
    // Loud skip — NOT a silent pass. Surfaces why in the test output.
    test.skip(
      `SKIPPED: no model backend (set ANTHROPIC_API_KEY to run the judge over the golden dataset, threshold ≥ ${ACCURACY_THRESHOLD})`,
      () => {},
    );
    return;
  }

  test(
    `claudeJudge accuracy ≥ ${ACCURACY_THRESHOLD} over the golden dataset`,
    async () => {
      const dataset = loadDataset();
      const report = await runEval(dataset, createClaudeJudge());
      // Surface the breakdown so a failure is diagnosable from the log alone.
      console.log(
        `judge accuracy=${report.accuracy.toFixed(3)} (${report.correct}/${report.total}) ` +
          `macroP=${report.macroPrecision.toFixed(3)} macroR=${report.macroRecall.toFixed(3)}; ` +
          `misjudged=${report.misjudged.map((m) => `${m.id}:${m.expected}->${m.predicted}`).join(", ") || "none"}`,
      );
      expect(report.accuracy).toBeGreaterThanOrEqual(ACCURACY_THRESHOLD);
    },
    600_000, // a full judging pass over the dataset can take minutes
  );
});
