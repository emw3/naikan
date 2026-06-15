# 12 — UI visual regression (baseline approval + diff + ignore regions)

Status: done — human-approved 2026-06-03. Masked pixelmatch diff built TDD-first
in `ui-runner` (pure `diffScreenshots`; ignore-region masks painted on both
images; dimension mismatch fails the viewport, no pad-and-compare). The worker
loads the baseline via `baseline-store` and injects it (ui-runner stays pure),
uploads diff overlays, writes `manifest.diffs`, and fails the run on any
regression. Promote-to-baseline endpoint copies bytes into the baseline subtree
(not a re-point) + audits who/when/which run; admin button + side-by-side
baseline|current|diff viewer in web-admin. Verified live on the local stack:
unchanged re-run 0%/pass, modified fixture 12.88%/fail. Masking decision: option
(b) — `capture` stays screenshot-pure, returns mask boxes; `ui-runner` paints.
Category: enhancement
Type: AFK

## Parent

`docs/mvp/PRD.md`

## What to build

Extend `ui-runner` to perform a pixelmatch diff against the per-viewport approved baseline. Mask `ignore_regions` (CSS selectors) before diffing. Compute a per-viewport diff percentage; the check fails the visual signal if any viewport exceeds `diff_threshold`.

**Dimension-mismatch rule (full-page screenshots, ADR-0006 / #11a):** screenshots are full-page so height varies with content. If a run's screenshot dimensions differ from the baseline's, the visual signal **fails** for that viewport (the layout height shifted) — do not silently pad-and-compare into a misleadingly-low diff %. Run masked pixelmatch only when dimensions match.

**Masking — open design decision for this slice:** either (a) `capture` masks the `ignore_regions` selectors *in-browser before the screenshot* (cleanest pixels; `capture` grows to accept mask selectors), or (b) `capture` returns the selectors' bounding boxes and `ui-runner` paints masks on both images before pixelmatch (`capture` stays screenshot-pure, masking is domain logic). Pick one when grabbing this; (b) keeps the capture seam purer.

Add `"diffs": { "<viewport>": { "pct": <n>, "key": "…/<vp>.diff.png" } }` to the per-run `manifest.json` (#11b).

Admin UI:
- a "Promote to baseline" button on any CheckRun's detail view that copies the run's per-viewport screenshots to the baseline ref for that UICheck (one-click);
- a side-by-side viewer (baseline | current | diff overlay) per viewport for any run.

End-to-end demo: admin defines a UI check, promotes the first run as baseline; subsequent runs against an unchanged page diff at 0%; deliberately modify the fixture, re-run, see diff %, see check flagged as regressed visually.

## Acceptance criteria

- [x] `ui-runner` extended with masked-diff: baseline loaded via `baseline-store` (by the worker) and injected, ignore-region masks applied, pixelmatch run, diff % + diff buffer returned per viewport
- [x] `UICheck.baseline_image_ref` stores a manifest pointing to per-viewport baseline keys
- [x] "Promote to baseline" endpoint + button; baseline copy goes through `baseline-store` (does not just re-point at the run's key)
- [x] Per-viewport diff threshold compared to `UICheck.diff_threshold`
- [x] Side-by-side viewer UI per viewport (presigned URLs for baseline/current/diff)
- [x] Tests: pixelmatch on identical inputs returns 0; on a known-modified fixture returns a known >0 value; ignore-region masks a region successfully
- [x] Audit-log entry on baseline promotion (who, when, which run promoted)

## Blocked by

- #11b
