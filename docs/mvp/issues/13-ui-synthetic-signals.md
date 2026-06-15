# 13 — UI synthetic signals (load, console, selector, perf) with per-signal severity

Status: ready-for-agent
Category: enhancement
Type: AFK

## Parent

`docs/mvp/PRD.md`

## What to build

**First extend `@naikan/capture`** (screenshot-only until now, #11a) to also collect raw observations in the same page session — at near-zero cost since the page is already loaded: `nav` (transport ok + HTTP status), `console` messages, `perf` (LCP, weight bytes, request count via PerformanceObserver + response listeners), and `selectorsPresent` (which of the requested selectors resolve). `capture` still makes **no judgment** — it returns these as plain data on `CaptureResult`.

**Then extend `@naikan/ui-runner`** to turn those raw observations into 4 judged signals per run:
- **load** — did the page navigate successfully (no transport error, response 2xx)?
- **console** — JS console errors during the run
- **selector** — every selector in `UICheck.selectors[]` resolved to at least one element
- **perf** — LCP, page weight bytes, request count — each compared to `perf_budget`

Each signal has a configurable severity (`critical` or `warning`) on the UICheck. Aggregation rule: a run is *failed* if any signal failed; alert routing for the failure is decided per-signal — `critical` triggers the alerter (wired up in #14), `warning` contributes only to the digest.

Defaults pre-filled in the create form: load=critical, others=warning; perf budget LCP<2.5s, weight<3MB, requests<100.

End-to-end demo: a UI check against a fixture page with intentional console error + a missing selector fails with two warning signals; the same check against a clean page passes; tweaking severity to critical on console error changes the alert behaviour (verified once #14 lands).

## Acceptance criteria

- [x] `@naikan/capture` extended: `CaptureResult` gains `nav`, `console[]`, `perf`, `selectorsPresent` — collected in the existing page session, still judgment-free
- [x] `ui-runner` returns signal results: `{ load, console, selector, perf }` each with `pass: boolean`, `severity: 'critical' | 'warning'`, `detail`
- [x] Add `"signals": {…}` to the per-run `manifest.json` (#11b) so the detail page renders per-viewport signal status without recomputation
- [x] Per-signal severity fields editable in admin UI with pre-filled defaults
- [x] Detail page renders per-viewport per-signal status with the failing detail (e.g. "console: ReferenceError x is not defined at …")
- [x] `CheckRun.status` reflects pass/fail aggregation
- [x] Tests: fixture HTML page with controlled console errors, missing selector, slow LCP — assert each signal's pass/fail matches expectation

## Blocked by

- #11b
