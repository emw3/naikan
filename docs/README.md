# Docs — the paper trail

Naikan was built spec-first: every feature started as a PRD, was sliced into
independently-shippable tracer-bullet issues, planned, then implemented. The
artifacts below are that trail — kept in-repo on purpose, because the *reasoning*
is as much the point as the code.

Start with [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the narrative tour, then
drill in here.

## Architecture Decision Records — [`adr/`](adr/)

The load-bearing "why", one decision per file:

| ADR | Decision |
| --- | --- |
| [0001](adr/0001-worker-runtime.md) | Worker on **Node**, API on **Bun** — settled by a 50-iteration Playwright benchmark |
| [0002](adr/0002-s3-key-convention.md) | S3 artifact key scheme — baselines live outside the `runs/` subtree so retention never reaps them |
| [0003](adr/0003-email-provider.md) | Transactional email via Resend, behind a swappable `dispatch()` seam |
| [0005](adr/0005-repo-layout.md) | Bun-workspaces monorepo with a runtime-agnostic kernel |
| [0006](adr/0006-ui-capture-packages.md) | UI capture split into two Node-only packages, import-fenced to the worker |
| [0007](adr/0007-ui-vercel-dark-direction.md) | The web-admin moves to a dark Vercel-dashboard design direction |

## Feature specs + slices

Each feature is a PRD plus the vertical slices it was cut into:

- [`mvp/`](mvp/) — the original platform PRD + 19 tracer-bullet slices (`issues/`).
- [`regression-judge/`](regression-judge/) — the agentic visual-regression judge (MCP server + eval suite) PRD + 6 slices.
- [`in-app-docs/`](in-app-docs/) — the in-app documentation hub brief + slices.

## Implementation plans — [`plans/`](plans/)

Per-feature implementation plans (task-by-task), produced before writing code for
the trickier slices.

## How this repo is driven by agents — [`agents/`](agents/)

How the engineering workflow consumes this repo: the domain docs, the
local-markdown issue tracker, and the triage-label mapping. See also
[`../AGENTS.md`](../AGENTS.md) and [`../.claude/skills/`](../.claude/skills/).
