# 06 — Eval harness + EVALS.md

Status: ready-for-agent
Category: enhancement
Type: AFK

## Parent

`docs/regression-judge/PRD.md`

## What to build

Prove the judge works — the highest-leverage artifact of this feature. A harness that
runs the judging logic over the golden dataset, scores each verdict against ground
truth, and reports the metrics; a regression test that fails if accuracy drops below a
documented threshold; and `EVALS.md` publishing the methodology, the numbers, and the
failure modes found.

**End-to-end demo:** run the eval → it prints precision / recall / a confusion matrix
over the golden dataset and lists the misjudged cases; the regression test passes at
the current threshold; `EVALS.md` shows the same numbers with the design + caveats.

## Acceptance criteria

- [ ] A deep `runEval(dataset, judge)` module: takes the labeled dataset + a judge function, returns precision, recall, a confusion matrix over the four verdict kinds, and the list of misjudged cases (predicted vs expected + the run reference)
- [ ] `runEval` is **unit-tested with a fake judge** over a small in-line fixture set — deterministic metric math + correct collection of misjudges (no model call in the unit test)
- [ ] A grader that turns the four-way verdict into a correct/incorrect comparison against ground truth (binary-leaning); transcripts/reasoning retained for inspection
- [ ] A **regression test** that runs the judge over the golden dataset (slice 05) and asserts accuracy ≥ a documented threshold; gated so it can run where a model is available, and clearly skipped (not silently passing) where it isn't
- [ ] `EVALS.md` published: the dataset (size, label balance, synthetic vs curated split), the grader + harness design, the measured precision/recall + confusion matrix, and an honest **failure-modes / limitations** section (where the judge is wrong, cost/latency notes)
- [ ] `EVALS.md` is linked from the README so it's discoverable
- [ ] existing `bun test` + `bun run typecheck` pass

## Blocked by

- `docs/regression-judge/issues/03-mcp-server-and-judging-skill.md` (the judging skill = the judge under test)
- `docs/regression-judge/issues/05-eval-golden-dataset-fixtures.md` (the labeled dataset)
