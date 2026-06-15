# Worker-runtime spike (issue #02 → ADR-0001)

Time-boxed spike to decide whether the Playwright-driving worker runs on Bun or Node.
**Outcome: Node.** See `docs/adr/0001-worker-runtime.md`.

## Run it

```sh
# from repo root — needs the Chromium binary once: bunx playwright install chromium
bun run apps/worker/spike/run.mjs
```

Writes `results.json` and prints a Bun-vs-Node comparison table.

## What it does

- `spike.mjs` — identical `.mjs` run under **both** `bun` and `node`, so the only variable
  is the JS runtime. Per iteration: launch a **fresh** headless Chromium → `file://`
  fixture → screenshot → capture console + Navigation Timing → close. 50 iterations.
  A 40 s per-iteration watchdog (`SPIKE_WATCHDOG_MS`) force-kills a wedged browser and
  records a failure so the run always completes 50 on each runtime.
- `run.mjs` — orchestrator: runs Node then Bun, parses each summary, writes `results.json`.
- `fixture.html` — static page (heading, a `console.log` + `console.error` to exercise
  console capture, a little DOM work for non-trivial perf timing).

## Result (50 iterations each)

| metric        | Bun 1.3.14 | Node 22.19.0 |
| ------------- | ---------- | ------------ |
| success       | 46 / 50    | 50 / 50      |
| peak RSS      | 145.8 MB   | 167.5 MB     |
| total wall    | 138 s      | 13 s         |

Bun fails ~8% of browser launches with `ENOENT` from its `node:child_process` stdio shim
inside Playwright's `launchProcess`. Node is clean. Full rationale in ADR-0001.

Env vars: `SPIKE_ITERATIONS` (default 50), `SPIKE_WATCHDOG_MS` (default 40000).
