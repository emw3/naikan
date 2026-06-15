# 11a — `@naikan/capture` + `@naikan/ui-runner` packages (built from scratch)

Status: done — human-approved 2026-06-03. Both packages built TDD-first; capture
(8 tests) + ui-runner (7 unit + 1 real-Chromium integration) green; non-test source
tsc-clean; Node strip-only import verified; import fence intact (api untouched). Worker
wiring follows in #11b.
Category: enhancement
Type: AFK

## Parent

`docs/mvp/PRD.md`

## What to build

The UI capture kernel, **built in-repo from scratch** — there is no external `sentinel` repo
to copy from (see CONTEXT.md "Flagged ambiguities"; the term is retired). Two new `packages/*`
modules, both Node-only with a real `playwright` dependency, import-fenced to the worker per
**ADR-0006**:

- **`@naikan/capture`** — site-agnostic Playwright session. `capture(url, sizes[], opts)
  → CaptureResult[]`. One Chromium launch internally, one isolated context per size,
  full-page screenshot per size. Returns **only plain data** (no Playwright type crosses the
  seam) and makes **no pass/fail judgment**. This slice collects the **screenshot only**;
  console/perf/selector collection is added in #13.
- **`@naikan/ui-runner`** — domain layer, depends on `@naikan/capture`. `runUI(config,
  baseline?) → { signals, artifacts }`. This slice maps the UICheck's viewports →
  `{label,width,height}`, calls `capture`, and returns `{ artifacts }` (per-viewport screenshot
  buffers). `signals` is empty here (lands in #13); diff lands in #12. **No S3 writes, no DB
  inside** — mirrors `heartbeat-runner` (pure executor, side-effects injectable).

Determinism contract for `capture.opts` (defaults): disable CSS animations/transitions, force
`prefers-reduced-motion`, wait for `load` + `document.fonts.ready` + a configurable settle
delay, hard navigation timeout. Screenshots are **full-page** (`fullPage: true`).

## Acceptance criteria

- [ ] `@naikan/capture` created; `playwright` is a real dependency (graduated from the
      `apps/worker` devDependency added by the #02 spike). `capture(url, sizes[], opts)
      → CaptureResult[]`; `CaptureResult = { label, screenshot: Buffer, dims: {w,h} }` this slice.
- [ ] One Chromium launch per `capture()` call; one isolated context per size; full-page
      screenshot; determinism defaults applied.
- [ ] `@naikan/ui-runner` created, depends on `@naikan/capture`; `runUI(config, baseline?)
      → { signals: [], artifacts }` returning per-viewport screenshot **buffers** — no S3, no DB.
- [ ] A fake `BrowserDriver` seam lets `ui-runner`/`capture` unit-test without launching Chromium.
- [ ] **ADR-0006 committed** (it is; verify the packages match it): both packages Node-only,
      import-fenced — only `apps/worker` may depend on them; the Bun `api` must not.
- [ ] Tests: `ui-runner` against a **local fixture HTML page** asserts a screenshot buffer is
      produced for all 3 viewports (one real-Chromium integration test); fake-driver unit tests
      cover viewport mapping + aggregation shape.

## Blocked by

- #02 (Playwright/Node runtime decision — ADR-0001, done)

## Notes

- Replaces the dead acceptance criterion in the old #11 ("copy capture kernel from `sentinel`
  + write `SYNC.md` + record sentinel commit"). No `sentinel`, no `SYNC.md`.
- `capture` grows additively in later slices: #12 adds ignore-region masking inputs, #13 adds
  console/perf/selector collection. The seam (plain-data-out, judgment in `ui-runner`) holds.
