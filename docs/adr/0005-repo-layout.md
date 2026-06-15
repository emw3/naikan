---
status: accepted
---

# Repo layout — Bun workspaces monorepo with a runtime-agnostic kernel

`naikan` is scaffolded as a Bun **workspaces monorepo**: `packages/*` holds the
plain-TypeScript kernel modules (e.g. `incident-machine`, `baseline-store`, the check
runners) with **no Bun-specific APIs**, and `apps/*` holds the deployable processes —
`api` (Bun + Hono), `worker` (Bun *or* Node, decided in ADR-0001 / issue #02), and
`web-admin` (Svelte + Vite). The split exists so the worker can fall back to a Node
runtime without dragging Bun-only APIs into shared code, per the Playwright/Bun risk
flagged in the PRD (lines 76, 164).

## Considered options

- **Flat single-package `src/` layout** — rejected. One package couples every process to a
  single Bun toolchain, which fights the Node worker fallback: the kernel could no longer be
  imported by a Node-based worker without contamination from Bun-only APIs.

## Consequences

- All downstream AFK issues (#03–#19) build on this layout; their modules land under
  `packages/*` (kernel) or `apps/*` (processes).
- Kernel packages **must** stay free of Bun-specific APIs. This is the structural enforcement
  of the PRD's "kernel runs on either runtime" constraint — verified at code review until/unless
  the #02 spike confirms Bun for the worker.

## ADR numbering

ADR numbers 0001–0004 are reserved by issues that pre-allocate them in their own text:
0001 (#02 worker runtime), 0002 (#04 S3 key convention), 0003 (#10 email provider),
0004 (#19 IaC tool). This layout decision is therefore numbered **0005**. Numbers below it
are intentionally absent until their owning issues land.

---

*Originated from an AI-assisted `/triage` grilling session for issue #01.*
