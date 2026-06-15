---
status: accepted
---

# S3 artifact key convention

Artifacts (run screenshots, diff overlays, approved baselines) are stored in a single
S3-compatible bucket under a hierarchical key scheme owned by the `baseline-store` module
(`packages/baseline-store`). No call site hand-builds a key — they all go through
`artifactKeys`.

## Layout

```
projects/<projectId>/checks/<checkId>/runs/<runId>/<viewport>.png        run screenshot
projects/<projectId>/checks/<checkId>/runs/<runId>/<viewport>.diff.png   run diff overlay
projects/<projectId>/checks/<checkId>/baseline/<viewport>.png            approved baseline
```

`<viewport>` is one of `mobile` / `tablet` / `desktop` (PRD UI checks). Id segments must not
be empty or contain `/` — `artifactKeys` throws if they do, so a malformed id can never
collapse the hierarchy.

## Why this shape

- **Project-first prefix** (`projects/<projectId>/`) makes per-project operations a single prefix
  scan — the unit the retention reaper (#17) and per-project retention windows operate on, and
  the natural boundary for a future per-project bucket-policy or deletion-on-offboard.
- **Baselines live outside the `runs/` subtree**, not interleaved with run artifacts. This is
  load-bearing for retention: the reaper deletes aged artifacts under
  `projects/<id>/checks/<id>/runs/` while structurally exempting
  `projects/<id>/checks/<id>/baseline/` — no per-object "is this the live baseline?" lookup
  needed. Baseline approval (promote-to-baseline) is a copy from a run key to the baseline key.
- **Diff overlay shares the run/viewport stem** with a `.diff.png` suffix, so a run's
  screenshot and its diff sort adjacently and are discoverable from one prefix.

## Considered options

- **Flat keys with metadata** (e.g. `<uuid>.png` + a DB row holding project/check/run) —
  rejected. Pushes all hierarchy into Postgres, makes "delete everything for project X" a
  join-and-loop instead of a prefix delete, and loses human-debuggability of the bucket.
- **Date-partitioned prefix** (`YYYY/MM/DD/...`) — rejected for the MVP. Retention here is
  per-project-days, not global-time, so a project prefix maps to the policy boundary more
  directly; date partitioning would scatter one project's artifacts across many prefixes.

## Consequences

- The key scheme is committed; changing it later requires a migration of existing objects.
- `baseline-store` exposes `runScreenshot` / `runDiff` / `baseline` builders plus
  `projectPrefix` / `runsPrefix` / `baselinePrefix` scoping helpers for `list()`.
- Retention *enforcement* is **not** in this module (#17); the layout exists to make that
  reaper a prefix scan with a structural baseline exemption.

---

*Originated from issue #04 (AFK agent). ADR number 0002 was pre-reserved for this decision in
ADR-0005.*
