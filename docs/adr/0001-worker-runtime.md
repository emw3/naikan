---
status: accepted
---

# Worker runtime — Node (API stays on Bun)

The `worker` process — the one that drives Playwright/Chromium for heartbeat and UI
checks — runs on **Node**. The `api` process stays on **Bun**. The `packages/*` kernel
stays plain TypeScript with no Bun-specific APIs (already mandated by ADR-0005), which is
what makes a Node worker importing the same kernel possible.

This resolves the spike flagged in the PRD (lines 76, 164) and issue #02.

## Why

A time-boxed spike launched a **fresh** headless Chromium per iteration (cold-start each
time — the harshest case, and the one a per-check worker actually hits), navigated to a
local `file://` fixture, took a screenshot, and captured console messages + Navigation
Timing. **50 iterations on each runtime, identical `.mjs` harness**, so the only variable
was the JS runtime driving Playwright. Code lives at `apps/worker/spike/`
(`bun run apps/worker/spike/run.mjs`); raw numbers in `apps/worker/spike/results.json`.

| metric (50 iterations)   | Bun 1.3.14            | Node 22.19.0 |
| ------------------------ | --------------------- | ------------ |
| success                  | **46 / 50**           | **50 / 50**  |
| failures                 | **4**                 | **0**        |
| peak driver RSS          | 145.8 MB              | 167.5 MB     |
| avg run, successful iters | 225.4 ms             | 225.5 ms     |
| avg browser launch, successful iters | 59.2 ms   | 60.3 ms      |
| total wall-clock         | 138 s                 | 13 s         |

Reading the numbers:

- **Bun fails ~8% of browser launches.** The four failures (iterations 22, 26, 37, 44 —
  consistently starting around the ~22nd launch across two independent runs) surface as
  `launch:`/`waitForSelector: Timeout 30000ms exceeded`, each accompanied by a
  `Failed to connect … syscall "connect" … errno -2 (ENOENT)` thrown from
  `childProcess.spawn` inside Playwright's `launchProcess` → `#createStdioObject`. The fault
  is in **Bun's `node:child_process` stdio-pipe shim** failing to establish the pipe to
  Chromium after a number of rapid spawn/teardown cycles — precisely the "Playwright on Bun
  has had rough edges" risk the PRD called out.
- **The 138 s vs 13 s wall-clock gap is entirely those four 30 s timeouts**, not per-iter
  slowness. When Bun succeeds, it is indistinguishable from Node (225 ms run, 59 ms launch,
  byte-identical screenshots, identical console capture). Bun is not *slower* — it is
  *unreliable* at the launch boundary.
- **Node completed 50/50 with zero failures** in the same WSL2 environment, same Chromium
  build (Chrome-for-Testing 148), back-to-back with the Bun run. Peak RSS is ~15% higher but
  trivially within budget for a RAM-scaled worker pool.

A worker that launches a browser per check cannot tolerate an 8% launch-failure rate (it
would manufacture false "site down" incidents). Node is stable; Bun is not. Decision is
clear-cut, so the PRD's "prefer Bun for toolchain uniformity unless unstable" tiebreaker
does not apply.

## Considered options

- **Worker on Bun (uniform toolchain).** Rejected — 8% launch failures from the Bun
  child_process/pipe shim. Retest when Bun ships a fix; the kernel split keeps the door open.
- **Worker on Bun with a launch-retry wrapper.** Rejected for the MVP — papers over a
  runtime defect, still pays 30 s timeouts per miss, and adds complexity to the hot path.
- **Everything on Node (drop Bun entirely).** Rejected — the API runs fine on Bun and Bun is
  the chosen API/toolchain runtime (ADR-0005); only the Playwright-driving worker is affected.

## Consequences

- **#11 onward** (UI-check runners, capture, the worker queue consumer) target the Node
  runtime. `apps/worker` is started with Node — its `package.json` `start` script and any
  Dockerfile/ECS task definition (#19) use `node`, not `bun`, for the worker.
- **`packages/*` must stay free of Bun-specific APIs** — now load-bearing, not precautionary:
  the Node worker imports the same kernel the Bun API does. Enforced at code review per
  ADR-0005.
- The split deploy already assumed by the PRD (separate worker task definition, scaled for
  Playwright RAM) is unchanged — it is now also a runtime split (Node worker, Bun API).
- Spike artifacts (`apps/worker/spike/`, `playwright` devDependency on `apps/worker`) are kept
  as reproducible evidence and a head start on #11's real runners.
- **Revisit trigger:** if a future Bun release fixes `node:child_process` pipe stability,
  re-run `apps/worker/spike/run.mjs`; a clean 50/50 would let the worker fold back onto Bun.

---

*Originated from the issue #02 spike (AFK agent, 2026-06-02). Numbers reproducible via
`bun run apps/worker/spike/run.mjs`.*
