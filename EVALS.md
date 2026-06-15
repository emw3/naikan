# Naikan regression-judge — evaluation

Naikan ships an AI **regression judge**: given a UI check run's screenshot diff
(baseline | current | diff overlay + diff% + Signals), it classifies the diff as a
real visual regression, noise, an intentional change, or uncertain, and records an
advisory verdict. The judge is Claude, driven by the bundled `regression-judge`
skill over the `@naikan/mcp` server. A human always stays the authority — no verdict
auto-promotes a baseline.

Because the whole point is *trustworthy* judgment, the judge is measured, not
asserted. This document is the measurement: the labeled dataset, the grader and
harness, the numbers, and — honestly — where the judge is weakest.

Everything here is reproducible from `@naikan/eval-dataset` (`packages/eval-dataset`).

## What is measured

The eval harness `runEval(dataset, judge)` runs a **judge function** over the labeled
golden dataset and scores each verdict against ground truth. The judge under test is
`createClaudeJudge()` — the eval-suite counterpart of the shipped skill: it reads each
fixture's baseline/current/diff images + diff% + Signals straight off disk and
classifies the diff with Claude vision, applying the same four-way taxonomy the skill
encodes. It is the same judgment the platform performs in production, pointed at
committed fixtures instead of live MCP runs.

The judge is **injected**, not hard-wired: `runEval` takes any `(fixture) =>
JudgeOutput` function. The unit tests pass a deterministic fake judge; the regression
test passes the real model-backed judge. The harness itself never calls a model or
reads an image — it orchestrates and grades.

## Dataset

A **hybrid** golden corpus of 9 fixtures (`packages/eval-dataset/fixtures/`), balanced
across the three constructable ground-truth labels. Each fixture is one viewport's
judging input: a baseline screenshot, a current screenshot, the diff overlay + diff%,
the run's Signals, and a ground-truth label.

| | real_regression | noise | intentional | total |
|---|---|---|---|---|
| **synthetic** | 2 | 2 | 2 | 6 |
| **curated (real)** | 1 | 1 | 1 | 3 |
| **total** | **3** | **3** | **3** | **9** |

- **Synthetic (6)** — deterministic seed pages captured through the *real* capture +
  diff pipeline (`runUI` → `@naikan/capture` → `diffScreenshots`), so the artifacts
  are genuine diffs, not hand-mocked: a pricing card pulled out of flow
  (`layout-break`), an image overflowing its grid (`overflow-break`), a ticking
  status-page timestamp (`live-clock`), a rotating marketing hero (`rotating-hero`), a
  rebrand (`brand-restyle`), a typography refresh (`type-restyle`). Labeled by
  construction — the generator knows what it changed.
- **Curated (3)** — captured from real public sites, each with a human-confirmed
  label: GitHub's page with vs. without its stylesheet (`real-broken-css` →
  real_regression), GitHub 2012 vs. 2023 Wayback snapshots (`real-redesign-github` →
  intentional), and a Lorem Picsum endpoint returning a different random photo per load
  (`random-photo` → noise). Diff fractions span 0.05 % → 100 %, and two curated cases
  have mismatched dimensions (no diff overlay — itself evidence).

**Label vocabulary.** `real_regression` | `noise` | `intentional` | `uncertain`. The
first three are constructable ground truths. `uncertain` is a valid *verdict* the judge
may emit when it genuinely can't tell, but it is not a constructable *ground truth* (you
cannot build a page that is objectively "uncertain"), so no fixture is labeled
`uncertain` — it exists only so the confusion matrix has a column for it.

## Grader & harness design

**Binary-leaning grading.** A verdict is correct iff it equals the fixture's
ground-truth label. The four-way verdict collapses to correct/incorrect for accuracy,
while the confusion matrix preserves *which* class it was confused for. Transcripts
(the judge's confidence + reasoning) are retained on every result and surfaced on every
misjudge, so a wrong call is inspectable, not just counted.

`runEval` returns:

- **accuracy** = correct / total.
- a **confusion matrix** over the four verdict kinds, keyed `[expected][predicted]`.
- **per-label** support, precision (TP / predicted), recall (TP / support), and F1.
- **macro** precision/recall/F1, averaged over labels that occur as ground truth
  (support > 0). `uncertain` has no support and is excluded from the macro means —
  including it would unfairly penalise a judge for honestly punting; it still appears in
  the confusion matrix so its prediction rate stays visible.
- the **misjudged** list — predicted vs. expected, the fixture reference, and the
  judge's reasoning.

The metric math (`grade.ts`) is pure and unit-tested with a fake judge over an inline
fixture set (`eval.test.ts`) — deterministic precision/recall/confusion arithmetic and
correct misjudge collection, with no model call. Fixtures are judged **sequentially**
so the misjudged list is reproducible run to run.

## Results

Measured by running **Claude Opus 4.8** (`claude-opus-4-8`) over the 9-fixture golden
set on **2026-06-12**, applying the judging-skill taxonomy to each fixture's
baseline/current/diff + Signals + diff%. The automated regression test
(`judge.regression.test.ts`) reproduces this with the same model via `createClaudeJudge`
wherever `ANTHROPIC_API_KEY` is set.

**Accuracy: 9 / 9 = 1.00.** Macro precision 1.00, macro recall 1.00, macro F1 1.00.

Confusion matrix (rows = ground truth, columns = predicted):

| expected \ predicted | real_regression | noise | intentional | uncertain |
|---|---|---|---|---|
| **real_regression** | 3 | 0 | 0 | 0 |
| **noise** | 0 | 3 | 0 | 0 |
| **intentional** | 0 | 0 | 3 | 0 |
| **uncertain** | 0 | 0 | 0 | 0 |

Per-fixture verdicts (confidence is the judge's self-report):

| fixture | source | truth | verdict | conf | note |
|---|---|---|---|---|---|
| layout-break | synthetic | real_regression | real_regression | 0.92 | card pulled out of flow, overlapping neighbours |
| overflow-break | synthetic | real_regression | real_regression | 0.90 | oversized image overflows the grid |
| real-broken-css | curated | real_regression | real_regression | 0.95 | stylesheet failed to load; FAIL console/perf corroborate |
| live-clock | synthetic | noise | noise | 0.92 | only the timestamp/counter/request-id ticked |
| rotating-hero | synthetic | noise | noise | 0.68 | hero hue + testimonial rotate; layout intact |
| random-photo | curated | noise | noise | 0.55 | full-bleed photo swapped; nothing broken |
| brand-restyle | synthetic | intentional | intentional | 0.90 | deliberate recolour + pill buttons; layout intact |
| type-restyle | synthetic | intentional | intentional | 0.85 | serif→sans + accent headings; content unchanged |
| real-redesign-github | curated | intentional | intentional | 0.72 | coherent multi-year redesign despite FAIL signals |

## Failure modes & limitations

A perfect score on nine fixtures is **not** "the judge is always right." It means the
judge cleared a small, deliberately-spanning set. Read this section before trusting the
number.

- **Tiny dataset (n = 9).** The confidence interval on 9/9 is wide. One additional
  misjudge would drop accuracy to 8/9 = 0.89; two to 7/9 = 0.78. Treat the headline as
  "no systematic failure on the covered cases," not a precise accuracy estimate. Growing
  the corpus is the highest-value next step.
- **Where the judge is closest to wrong.** Two fixtures are genuinely borderline and are
  the most likely to flip on a re-run or a prompt change:
  - `random-photo` (confidence 0.55) — a 95.7 % diff that is a *complete* image swap.
    Distinguishing "rotating/randomised media" (noise) from "the hero image was
    deliberately replaced" (intentional) is hard without temporal context; the judge
    leans noise because both images render cleanly and all Signals pass.
  - `real-redesign-github` (confidence 0.72) — the run carries **FAIL** console/perf
    Signals (Wayback asset hiccups), which point toward a break, yet the current page is
    a coherent, intact redesign. The judge correctly weights the pixels over the
    Signals here, but a judge that trusted the Signals would call it `real_regression`.
    This signals-vs-pixels tension is the single most likely source of future errors.
- **`uncertain` is never graded as ground truth.** No fixture is labeled `uncertain`, so
  the eval does not measure whether the judge punts *appropriately* — only that an
  `uncertain` verdict counts as incorrect against a constructable label. Calibration of
  the punt is unmeasured.
- **Single run, non-deterministic model.** These numbers are one pass. The judge uses
  adaptive thinking; verdicts on the borderline cases can vary between runs. The
  regression threshold (below) is set to absorb that variance.
- **Synthetic-heavy.** Two-thirds of the corpus is generated. The synthetic breaks are
  clean, single-cause cases; real regressions are often subtler and multi-cause. The
  three curated cases are the credibility anchor, not the bulk.
- **Cost & latency.** A full eval run is 9 sequential vision calls (3 images each) with
  adaptive thinking at `high` effort — roughly a few minutes wall-clock and on the order
  of ~$1 in Opus-4.8 tokens per run. The regression test allows up to 10 minutes and is
  gated behind `ANTHROPIC_API_KEY` so it never runs (or bills) in environments without a
  model.

## Regression threshold

`judge.regression.test.ts` asserts judge accuracy on the golden dataset is **≥ 0.70**
(`ACCURACY_THRESHOLD`). Rationale: measured accuracy is 1.00, and 0.70 tolerates up to
two misjudges out of nine (7/9 = 0.78 passes; 6/9 = 0.67 fails) — enough headroom for
normal model variance on the two borderline cases, but tight enough that a real
degradation (a prompt or model change that breaks judging on a third of the set) trips
CI. Raise the bar as the corpus grows and the interval tightens.

The test is **gated**: it runs only where a model backend is reachable
(`isModelAvailable()` — an `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` is set), and is
reported as **skipped** — never silently passed — where it isn't. An always-run wiring
check still exercises `loadDataset` ↔ `runEval` over the real corpus with deterministic
fake judges on every `bun test`.

## Reproduce

```sh
# Always-run: metric math + harness↔dataset wiring (no model)
bun test packages/eval-dataset

# Full judge accuracy run against the golden dataset (needs a model)
ANTHROPIC_API_KEY=sk-... bun test packages/eval-dataset/src/judge.regression.test.ts
```

Programmatically:

```ts
import { loadDataset, runEval, createClaudeJudge } from "@naikan/eval-dataset";

const report = await runEval(loadDataset(), createClaudeJudge());
console.log(report.accuracy, report.confusion, report.misjudged);
```
