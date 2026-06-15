# 02 — Playwright/Bun spike — decide worker runtime

Status: ready-for-human — spike complete; decision: worker runtime = **Node** (API stays Bun), see ADR-0001. Awaiting human review/merge.
Category: enhancement
Type: HITL

## Parent

`docs/mvp/PRD.md`

## What to build

Time-boxed (≤1 day) spike to determine whether the worker process can stably run Playwright on Bun, or whether the worker must be a Node process while the API stays on Bun.

Spin up a minimal worker that launches a Chromium instance via Playwright, navigates to a fixture URL, takes a screenshot, captures console messages and basic perf metrics. Run repeatedly (e.g. 50 iterations) on Bun and on Node. Compare: stability, memory profile, browser-launch cold-start time, native-module shim issues.

Outcome: a written decision recorded as an ADR (`docs/adr/0001-worker-runtime.md`) and a `Status:` update on this issue indicating which runtime is used by the worker process going forward.

## Acceptance criteria

- [x] Spike script launches Playwright on both Bun and Node, 50 iterations each
- [x] Metrics collected: success/failure count, RSS at peak, average run wall-clock
- [x] Any crashes or shimming workarounds documented
- [x] ADR-0001 written and committed under `docs/adr/`
- [x] Decision communicated; subsequent worker issues (#11 onwards) align with it

## Blocked by

- #01 (need the repo scaffold to host the spike code and ADR)

## Spike result (2026-06-02, AFK agent)

**Decision: the Playwright worker runs on Node; the API stays on Bun.** Recorded in
`docs/adr/0001-worker-runtime.md` (status: accepted).

Identical `.mjs` harness, 50 fresh-Chromium-per-iteration launches on each runtime
(`apps/worker/spike/`, run via `bun run apps/worker/spike/run.mjs`; raw data in
`apps/worker/spike/results.json`):

| metric (50 iters) | Bun 1.3.14 | Node 22.19.0 |
| ----------------- | ---------- | ------------ |
| success           | 46 / 50    | **50 / 50**  |
| peak RSS          | 145.8 MB   | 167.5 MB     |
| avg run (ok)      | 225.4 ms   | 225.5 ms     |
| avg launch (ok)   | 59.2 ms    | 60.3 ms      |
| total wall        | 138 s      | 13 s         |

- Bun fails **~8% of browser launches** (iters 22/26/37/44, consistent across two runs):
  `launch:`/`waitForSelector` 30 s timeouts, each with `Failed to connect … ENOENT` thrown
  from `childProcess.spawn` in Playwright's `launchProcess` — a defect in **Bun's
  `node:child_process` stdio-pipe shim** under repeated Chromium spawns. This is the PRD
  Playwright-on-Bun risk (lines 76, 164) materialising.
- When Bun *succeeds*, per-iter perf is identical to Node (same launch ms, byte-identical
  screenshots, identical console capture) — Bun is not slower, it is **unreliable at the
  launch boundary**. An 8% launch-failure rate would manufacture false "site down" incidents.
- No shims/workarounds were needed for Node; `--disable-dev-shm-usage` was *not* required
  (verified `/dev/shm` at 0% during the run). The Bun failures are not resource exhaustion.

**Follow-ups:** #11+ target the Node runtime for `apps/worker` (start command, Dockerfile,
#19 ECS task def use `node`). `packages/*` staying free of Bun-specific APIs (ADR-0005) is
now load-bearing — the Node worker imports the same kernel as the Bun API. Re-run the spike
if a future Bun release fixes child_process pipe stability.
