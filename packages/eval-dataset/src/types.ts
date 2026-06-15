/**
 * Types for `@naikan/eval-dataset` — the labeled golden corpus the regression
 * judge is measured against (regression-judge issue #05), consumed by the slice
 * #06 eval harness (`runEval(dataset, judge)`).
 *
 * A fixture is one viewport's worth of judging input: the three images an admin
 * (or the agent) sees — baseline | current | diff — plus the run's diff% and
 * Signals, and a **ground-truth label**. The harness asks a judge to classify the
 * fixture and scores its answer against `label`.
 *
 * No browser/DB types cross this seam: a fixture is plain data + image paths, so
 * the package stays a leaf (just `node:fs`/`node:path`). The corpus is generated
 * by `generate.ts`/`curate.ts` through the real capture+diff pipeline; this file
 * only describes what a generated fixture looks like once it is on disk.
 */

/**
 * The label vocabulary — ground-truth classes a diff can carry. Mirrors
 * `@naikan/config-repo`'s `VerdictKind` (the agent's verdict output) deliberately:
 * the judge is graded by comparing its `VerdictKind` to a fixture's `Label`. Kept
 * as a local literal rather than importing the type, so this leaf package does not
 * depend on the config/runtime layer for four strings. `generate.ts` carries a
 * compile-time check that the two unions stay in sync.
 *
 * `uncertain` is a valid *verdict* the agent may emit but is not a constructable
 * *ground truth* (you cannot build a page that is objectively "uncertain"), so the
 * synthetic + curated corpus never labels a fixture `uncertain`; it exists here
 * only so the grader's confusion matrix can have a column for it.
 */
export const LABELS = ["real_regression", "noise", "intentional", "uncertain"] as const;

/** A ground-truth label a fixture can carry. */
export type Label = (typeof LABELS)[number];

/** Where a fixture came from — generated synthetically vs. captured from a real site. */
export type FixtureSource = "synthetic" | "curated";

/**
 * One judged Signal as stored in a fixture — the plain-JSON shape the run manifest
 * records (mirrors `@naikan/ui-runner`'s `Signal`, kept local to avoid depending on
 * the browser layer). The judge reads these alongside the images.
 */
export interface FixtureSignal {
  kind: string;
  pass: boolean;
  severity: string;
  detail: string;
}

/**
 * One fixture as written to the manifest — image references are **relative** to the
 * dataset root so the committed manifest is path-portable. `loadDataset` resolves
 * them to absolute paths (`Fixture`).
 */
export interface ManifestFixture {
  /** Stable id, unique within the dataset; also the on-disk subdirectory name. */
  id: string;
  /** Ground-truth label this diff should be classified as. */
  label: Label;
  source: FixtureSource;
  /** Viewport the capture was taken at (`mobile` | `tablet` | `desktop`). */
  viewport: string;
  /** Differing-pixel fraction, 0..1, of current vs. baseline after masking. */
  diffPct: number;
  /** The run's judged Signals for this viewport. */
  signals: FixtureSignal[];
  /** Image references relative to the dataset root. `diff` absent on a dim mismatch. */
  images: {
    baseline: string;
    current: string;
    diff?: string;
  };
  /** Free-text provenance/rationale (esp. the human label note on curated cases). */
  notes?: string;
  /** Curated only: the real URLs the baseline/current captures came from. */
  sourceUrls?: { baseline?: string; current?: string };
}

/** The on-disk dataset manifest (`fixtures/manifest.json`). */
export interface DatasetManifest {
  /** Schema version, bumped on a breaking format change. */
  version: number;
  fixtures: ManifestFixture[];
}

/**
 * A fixture as returned by `loadDataset` — identical to `ManifestFixture` except
 * the image references are **absolute** filesystem paths (resolved against the
 * dataset root), so a consumer can read the bytes without knowing the root.
 */
export interface Fixture extends Omit<ManifestFixture, "images"> {
  baselinePath: string;
  currentPath: string;
  diffPath?: string;
}
