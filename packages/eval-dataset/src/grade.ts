/**
 * Grading math for the eval harness (issue #06) — the deterministic core that
 * turns a list of (expected, predicted) verdict pairs into the published metrics:
 * overall accuracy, a confusion matrix over the four verdict kinds, and per-label
 * precision / recall / F1. Pure (no I/O, no model), so it is unit-tested directly
 * through `runEval` with a fake judge.
 *
 * Grading is **binary-leaning**: a verdict is correct iff it equals the fixture's
 * ground-truth label. The four-way verdict collapses to correct/incorrect for
 * accuracy, while the confusion matrix preserves *which* class it was confused for.
 */
import { LABELS, type Label } from "./types.ts";

/** Confusion counts keyed `confusion[expected][predicted]` — a full 4x4 grid. */
export type Confusion = Record<Label, Record<Label, number>>;

/** Per-label scores. `precision`/`recall`/`f1` are `null` when undefined (0/0). */
export interface LabelMetrics {
  /** # fixtures whose ground truth is this label (confusion row sum). */
  support: number;
  /** # fixtures the judge predicted this label (confusion column sum). */
  predicted: number;
  /** Correctly predicted as this label (the diagonal cell). */
  truePositives: number;
  /** TP / predicted — `null` if the label was never predicted. */
  precision: number | null;
  /** TP / support — `null` if the label never appears as ground truth. */
  recall: number | null;
  /** Harmonic mean of precision/recall — `null` only when there is no support. */
  f1: number | null;
}

/** The full scored result of grading a set of verdict pairs. */
export interface Metrics {
  total: number;
  correct: number;
  accuracy: number;
  /** Macro-averages over labels with support > 0 (see note in `computeMetrics`). */
  macroPrecision: number;
  macroRecall: number;
  macroF1: number;
  byLabel: Record<Label, LabelMetrics>;
  confusion: Confusion;
}

function emptyConfusion(): Confusion {
  const grid = {} as Confusion;
  for (const expected of LABELS) {
    grid[expected] = {} as Record<Label, number>;
    for (const predicted of LABELS) grid[expected][predicted] = 0;
  }
  return grid;
}

function labelMetrics(label: Label, confusion: Confusion): LabelMetrics {
  const support = LABELS.reduce((sum, predicted) => sum + confusion[label][predicted], 0);
  const predicted = LABELS.reduce((sum, expected) => sum + confusion[expected][label], 0);
  const truePositives = confusion[label][label];

  const precision = predicted === 0 ? null : truePositives / predicted;
  const recall = support === 0 ? null : truePositives / support;
  let f1: number | null;
  if (support === 0) {
    f1 = null; // not a constructable class — no F1 to report
  } else if (precision === null || recall === null || precision + recall === 0) {
    f1 = 0;
  } else {
    f1 = (2 * precision * recall) / (precision + recall);
  }

  return { support, predicted, truePositives, precision, recall, f1 };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Score `pairs` into accuracy, a confusion matrix, and per-label metrics.
 *
 * Macro-averages cover only labels that occur as ground truth (`support > 0`).
 * `uncertain` is a valid verdict the judge may emit but is never a constructable
 * ground truth, so it has no support and is excluded from the macro means —
 * including it would unfairly penalise a judge for honestly punting. It still
 * appears in the confusion matrix and `byLabel` so its prediction rate is visible.
 */
export function computeMetrics(pairs: { expected: Label; predicted: Label }[]): Metrics {
  const confusion = emptyConfusion();
  for (const { expected, predicted } of pairs) confusion[expected][predicted] += 1;

  const byLabel = {} as Record<Label, LabelMetrics>;
  for (const label of LABELS) byLabel[label] = labelMetrics(label, confusion);

  const total = pairs.length;
  const correct = pairs.filter((p) => p.expected === p.predicted).length;
  const accuracy = total === 0 ? 0 : correct / total;

  const measured = LABELS.filter((label) => byLabel[label].support > 0);
  const macroPrecision = mean(measured.map((label) => byLabel[label].precision ?? 0));
  const macroRecall = mean(measured.map((label) => byLabel[label].recall ?? 0));
  const macroF1 = mean(measured.map((label) => byLabel[label].f1 ?? 0));

  return { total, correct, accuracy, macroPrecision, macroRecall, macroF1, byLabel, confusion };
}
