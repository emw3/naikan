/**
 * Unit tests for the eval harness `runEval` (issue #06) — driven by a **fake
 * judge** over a tiny in-line fixture set, so the metric math is deterministic and
 * no model is called. This is the pure core of the eval suite: given labeled
 * fixtures and a judge function, `runEval` must score every verdict against ground
 * truth and report accuracy, per-label precision/recall, a confusion matrix over
 * the four verdict kinds, and the list of misjudged cases (with reasoning retained
 * for inspection).
 *
 * The model-backed judge (`judge.ts`) is NOT exercised here — it is gated behind a
 * live model in `judge.regression.test.ts`. Here the judge is a pure lookup table.
 */
import { describe, expect, test } from "bun:test";
import { runEval, type Judge } from "./eval.ts";
import type { Fixture, Label } from "./types.ts";

/** Build a minimal Fixture; runEval only reads id/label/source (not the images). */
function fx(id: string, label: Label): Fixture {
  return {
    id,
    label,
    source: "synthetic",
    viewport: "desktop",
    diffPct: 0.1,
    signals: [],
    baselinePath: `/fake/${id}/baseline.png`,
    currentPath: `/fake/${id}/current.png`,
    diffPath: `/fake/${id}/diff.png`,
  };
}

/** A judge that returns a fixed verdict per fixture id — deterministic, no model. */
function tableJudge(table: Record<string, { verdict: Label; confidence?: number; reasoning?: string }>): Judge {
  return (fixture: Fixture) => {
    const entry = table[fixture.id];
    if (!entry) throw new Error(`tableJudge: no entry for ${fixture.id}`);
    return entry;
  };
}

// A 6-fixture set, balanced 2/2/2 across the three constructable ground-truth labels.
const DATASET: Fixture[] = [
  fx("rr1", "real_regression"),
  fx("rr2", "real_regression"),
  fx("noise1", "noise"),
  fx("noise2", "noise"),
  fx("int1", "intentional"),
  fx("int2", "intentional"),
];

describe("runEval", () => {
  test("a perfect judge scores accuracy 1 with no misjudged cases", async () => {
    const judge = tableJudge({
      rr1: { verdict: "real_regression" },
      rr2: { verdict: "real_regression" },
      noise1: { verdict: "noise" },
      noise2: { verdict: "noise" },
      int1: { verdict: "intentional" },
      int2: { verdict: "intentional" },
    });

    const report = await runEval(DATASET, judge);

    expect(report.total).toBe(6);
    expect(report.correct).toBe(6);
    expect(report.accuracy).toBe(1);
    expect(report.misjudged).toEqual([]);
    expect(report.macroPrecision).toBe(1);
    expect(report.macroRecall).toBe(1);
    expect(report.macroF1).toBe(1);
  });

  describe("a judge with two known errors", () => {
    // rr2 mislabeled noise (a real break called noise — the dangerous error);
    // int2 punted to uncertain. 4/6 correct.
    const judge = tableJudge({
      rr1: { verdict: "real_regression", confidence: 0.9, reasoning: "broken nav" },
      rr2: { verdict: "noise", confidence: 0.4, reasoning: "looked like jitter" },
      noise1: { verdict: "noise" },
      noise2: { verdict: "noise" },
      int1: { verdict: "intentional" },
      int2: { verdict: "uncertain", confidence: 0.2, reasoning: "could not tell" },
    });

    test("computes overall accuracy", async () => {
      const report = await runEval(DATASET, judge);
      expect(report.total).toBe(6);
      expect(report.correct).toBe(4);
      expect(report.accuracy).toBeCloseTo(4 / 6, 6);
    });

    test("builds a 4x4 confusion matrix keyed [expected][predicted]", async () => {
      const { confusion } = await runEval(DATASET, judge);
      expect(confusion.real_regression.real_regression).toBe(1);
      expect(confusion.real_regression.noise).toBe(1); // rr2 misjudged as noise
      expect(confusion.noise.noise).toBe(2);
      expect(confusion.intentional.intentional).toBe(1);
      expect(confusion.intentional.uncertain).toBe(1); // int2 punted
      // No fixture is ground-truth `uncertain`, so its row is all zeros.
      expect(confusion.uncertain.uncertain).toBe(0);
      expect(confusion.uncertain.real_regression).toBe(0);
    });

    test("computes per-label precision and recall", async () => {
      const { byLabel } = await runEval(DATASET, judge);

      // real_regression: TP=1, predicted=1, support=2
      expect(byLabel.real_regression.truePositives).toBe(1);
      expect(byLabel.real_regression.support).toBe(2);
      expect(byLabel.real_regression.precision).toBeCloseTo(1, 6);
      expect(byLabel.real_regression.recall).toBeCloseTo(0.5, 6);

      // noise: TP=2, predicted=3 (noise1, noise2, rr2), support=2
      expect(byLabel.noise.predicted).toBe(3);
      expect(byLabel.noise.precision).toBeCloseTo(2 / 3, 6);
      expect(byLabel.noise.recall).toBeCloseTo(1, 6);

      // intentional: TP=1, predicted=1, support=2
      expect(byLabel.intentional.precision).toBeCloseTo(1, 6);
      expect(byLabel.intentional.recall).toBeCloseTo(0.5, 6);

      // uncertain: never a ground truth (support 0) → recall is null, not 0/0=NaN
      expect(byLabel.uncertain.support).toBe(0);
      expect(byLabel.uncertain.recall).toBeNull();
    });

    test("macro-averages precision/recall over the constructable labels only", async () => {
      const { macroPrecision, macroRecall } = await runEval(DATASET, judge);
      // mean over {real_regression, noise, intentional} — uncertain (no support) excluded
      expect(macroPrecision).toBeCloseTo((1 + 2 / 3 + 1) / 3, 6);
      expect(macroRecall).toBeCloseTo((0.5 + 1 + 0.5) / 3, 6);
    });

    test("collects misjudged cases with reasoning + run reference retained", async () => {
      const { misjudged } = await runEval(DATASET, judge);
      expect(misjudged.map((m) => m.id).sort()).toEqual(["int2", "rr2"]);

      const rr2 = misjudged.find((m) => m.id === "rr2")!;
      expect(rr2.expected).toBe("real_regression");
      expect(rr2.predicted).toBe("noise");
      expect(rr2.confidence).toBe(0.4);
      expect(rr2.reasoning).toBe("looked like jitter");
      expect(rr2.source).toBe("synthetic");
    });

    test("results retains one entry per fixture with correctness flag", async () => {
      const { results } = await runEval(DATASET, judge);
      expect(results).toHaveLength(6);
      expect(results.find((r) => r.id === "rr1")!.correct).toBe(true);
      expect(results.find((r) => r.id === "rr2")!.correct).toBe(false);
    });
  });

  test("awaits an async judge (the model-backed shape)", async () => {
    const asyncJudge: Judge = async (fixture) => ({ verdict: fixture.label });
    const report = await runEval(DATASET, asyncJudge);
    expect(report.accuracy).toBe(1);
  });
});
