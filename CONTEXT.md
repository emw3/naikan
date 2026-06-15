# Naikan Monitor

Internal platform that watches a portfolio of project websites and tells the team about breakage before the project does. Two check families — fast **Heartbeat checks** and daily **UI checks** — feed **Incidents** (realtime paging) and the daily **Digest** (noise).

## Language

**Check**:
A configured probe against a project Site. Two kinds: **Heartbeat check** and **UI check**. Each execution produces a **Check run**.
_Avoid_: monitor, test, probe (as nouns for the configured thing).

**Heartbeat check**:
A fast (5–15 min) liveness probe — HTTP status, body assertion, SSL expiry, DNS. Pure network/transport; no browser. Lives in `@naikan/heartbeat-runner`.

**UI check**:
A daily browser-rendered check at three **Viewports** producing screenshots, a baseline **diff**, and synthetic **Signals**. Lives in `@naikan/ui-runner`.

**Capture**:
The act of loading a page in a real browser at one Viewport and recording raw observations — screenshot pixels, console messages, navigation/perf timing, selector presence. Capture makes **no pass/fail judgment**. The site-agnostic capture engine is `@naikan/capture`.
_Avoid_: scrape, crawl, snapshot (snapshot = the resulting screenshot artifact, not the act).

**Signal**:
One judged dimension of a UI check run — `load`, `console`, `selector`, or `perf` — each `{ pass, severity, detail }`. Severity is `critical` (can page) or `warning` (digest only). Judgment lives in `@naikan/ui-runner`, never in Capture.
_Avoid_: metric, check (a Signal is a sub-result of a UI Check run, not a Check).

**Viewport**:
One of three fixed render sizes — `mobile` / `tablet` / `desktop`. A UI check captures and diffs each independently.

**Baseline**:
The approved per-Viewport screenshot a run's screenshot is diffed against. Promoted from a Check run by a human (promote-to-baseline). Stored outside the `runs/` key subtree (ADR-0002) so retention never reaps it.
_Avoid_: reference image, golden (use Baseline).

**Diff**:
The pixelmatch comparison of a run screenshot against its Baseline for one Viewport, after masking `ignore_regions`, yielding a diff percentage and a diff overlay image. A Viewport fails the visual signal when its diff exceeds `diff_threshold`.

**Check run**:
One execution of a Check. For a UI check it carries the per-Viewport artifacts (screenshot, diff overlay) by reference and the aggregated Signal results.

**Incident**:
State opened when a check's incident-relevant signal fails the threshold number of consecutive runs; pages in realtime via the alerter; auto-closes after 2 consecutive successes (recovery alert carries the duration). Both check families feed the **same** incident-machine (#14):
- **Heartbeat check** — the signal is the run's pass/fail; the threshold is the effective `alert_after_n_fails`.
- **UI check** — the signal is whether a `critical`-severity **Signal** failed (threshold fixed at 1: pages on the first critical fail). `warning` signals and visual **Diff** regressions never open an Incident — they roll into the Digest only.

Because UI checks run daily, a UI incident's recovery alert lags up to ~48h (two successful daily runs). A UI **Check run** records `critical_failed` (the incident signal) separately from `status` (which fails on *any* signal/regression, for the Digest).

## Relationships

- A **Site** has many **Checks**; a **Check** is either a **Heartbeat check** or a **UI check**.
- A **UI check** runs once per **Viewport** (×3); each Viewport run is one **Capture** + (optionally) one **Diff** against that Viewport's **Baseline**.
- `@naikan/ui-runner` depends on `@naikan/capture`. Capture returns raw observations; `ui-runner` turns them into **Signals** and **Diffs** and aggregates a **Check run**.
- The Node **worker** is the only process that imports `ui-runner`/`capture` (Playwright is Node-only, ADR-0006); the Bun **api** enqueues a worker job for UI "Run now" and never imports them.

## Flagged ambiguities

- **"Sentinel"** — early issues (#11) referenced a `sentinel` repo as the source of a "capture kernel" to copy in. **No such repo exists.** Resolved: the capture engine is built in-repo as `@naikan/capture`; the term "sentinel" is retired. Do not reintroduce it.
- **"Capture kernel"** vs **"ui-runner"** — "capture kernel" = the low-level browser engine = `@naikan/capture` (raw observations, site-agnostic). "ui-runner" = the domain layer = `@naikan/ui-runner` (Signals, Diffs, aggregation). They are two packages, not one.
- **"Check"** vs **"Signal"** — a UI Check run has four Signals; a Signal is never itself called a "check".
