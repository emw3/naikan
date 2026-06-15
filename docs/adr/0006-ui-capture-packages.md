---
status: accepted
---

# UI capture lives in two Node-only kernel packages, import-fenced to the worker

The UI-check capture engine is built in-repo (there is no external `sentinel` repo to
copy from — see CONTEXT.md "Flagged ambiguities") as **two** `packages/*` modules:
`@naikan/capture` (site-agnostic Playwright session → raw observations) and
`@naikan/ui-runner` (domain layer: Signals, Diffs, aggregation, depends on `capture`).
Both carry a real `playwright` dependency and are therefore **Node-only**. Only the Node
`worker` imports them; the Bun `api` must never import either — for UI checks it enqueues a
worker job instead of running inline.

## Why

- ADR-0001 put the Playwright-driving worker on Node (Bun fails ~8% of browser launches).
  Anything importing Playwright is consequently Node-only.
- ADR-0005 bans **Bun-specific** APIs in `packages/*` so the kernel imports cleanly on either
  runtime — it does **not** ban Node deps (`heartbeat-runner` already uses `node:dns`/`node:tls`).
  A Playwright-bearing kernel package is therefore consistent with ADR-0005 *as long as the Bun
  api never imports it*. `capture`/`ui-runner` are the first kernel packages that are de-facto
  single-runtime; the import fence is what keeps ADR-0005's guarantee intact for everything else.
- Two packages (not one) keep a clean seam: `capture` returns only plain data
  (Buffers/arrays/numbers) and makes **no pass/fail judgment**; no Playwright type crosses the
  boundary. `ui-runner` owns every judgment (Signal severity, Diff threshold, aggregation). The
  seam leaves room for a future second consumer of `capture` (e.g. a crawler) without dragging
  domain logic along.

## Considered options

- **Capture logic inside `apps/worker` (no package).** Rejected — `playwright` is already a
  worker dep so it's the cheapest, but it welds domain logic to the deployable, blocks isolated
  package tests, and breaks symmetry with `heartbeat-runner` (a package).
- **One package with the Playwright driver internal.** Rejected — folding the low-level driver
  into `ui-runner` is simpler but loses the site-agnostic reuse seam; the project chose the
  two-package split deliberately for that boundary.
- **Pure `ui-runner` + injected `BrowserDriver`, Playwright only in the worker.** Rejected —
  keeps `ui-runner` dual-runtime but splits "the capture kernel" across a package and the app,
  and offers no benefit once the import fence already isolates Playwright to the worker.

## Consequences

- `playwright` graduates from an `apps/worker` devDependency (the #02 spike) to a real
  dependency of `@naikan/capture`. The #02 spike harness (`apps/worker/spike/`) is the head
  start for `capture`'s live driver.
- `capture`/`ui-runner` are **import-fenced**: only `apps/worker` may depend on them. Enforced
  at code review alongside the ADR-0005 Bun-API rule. The Bun `api` keeps running heartbeat
  run-now inline (`heartbeat-runner` is pure) but routes UI run-now through the worker queue.
- Chromium provisioning (`playwright install chromium` + system libs) becomes a worker
  build/deploy concern for #19 (Dockerfile / ECS task), not an api concern.
- `capture` returns a plain `CaptureResult[]`; growing it (console/perf/selector in #13) is an
  additive change behind the same seam.

---

*Originated from a `/grill-with-docs` session reworking issue #11 after the external `sentinel`
source was found not to exist. ADR number 0006: 0004 stays reserved for #19 (IaC tool) per
ADR-0005's numbering note.*
