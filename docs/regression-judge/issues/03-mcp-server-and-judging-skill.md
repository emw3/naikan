# 03 — @naikan/mcp server + judging skill

Status: ready-for-agent
Category: enhancement
Type: AFK

## Parent

`docs/regression-judge/PRD.md`

## What to build

The agentic loop end-to-end: a stdio **MCP server** the platform ships, plus the
bundled **judging skill** that drives it, so an agent (Claude or any MCP client) can
discover UI **Check runs**, fetch a run's baseline/current/diff + **Signals**, judge
the **Diff**, and write a **verdict** back — all over the scoped agent token from
slice 02. The server is useless without the skill and vice-versa, so they ship
together as one slice.

A small supporting **discovery endpoint** is part of this slice: the MCP needs a
single call to enumerate UI checks (today reads are per-site only).

**End-to-end demo:** with the stack running and `NAIKAN_AGENT_TOKEN` set, register
`@naikan/mcp` in an MCP client, invoke the judging skill against a regressed UI run
(seeded or created by hand): the agent calls `list_ui_checks` → `list_ui_runs` →
`get_ui_run` (sees the before/after/diff images + diff% + signals) → reasons →
`submit_verdict`. The verdict then appears in `GET /api/uichecks/:id/runs/:runId`.

## Acceptance criteria

- [ ] **Discovery endpoint** `GET /api/uichecks` returns the flat list of UI checks visible to the caller (manager-scoped), backed by a new repo method `listAllUIChecks()` over the store's existing `uichecks.listAll()`; route test (401 / 200 / manager-scoping) + config-repo test for `listAllUIChecks`
- [ ] New `@naikan/mcp` package (in `apps/mcp`, name `@naikan/mcp`): a **stdio** MCP server using `@modelcontextprotocol/sdk`; **plain TS, no Bun-only APIs** so it runs under Node too (ADR-0001/0005)
- [ ] Config from env: `NAIKAN_API_URL` (base URL) + `NAIKAN_AGENT_TOKEN` (bearer); fails fast with a clear message if unset
- [ ] **API client** (deep module): typed fetch wrapper over the HTTP API carrying the bearer token — `listUIChecks()`, `listRuns(checkId)`, `getRun(checkId, runId)`, `submitVerdict(checkId, runId, input)`; `fetch` injectable; **unit-tested against a fake fetch** (right path/method/Authorization header, response → typed result, non-2xx → error)
- [ ] **Tools** exposed: `list_ui_checks`, `list_ui_runs` (by checkId), `get_ui_run` (returns presigned baseline/current/diff URLs + per-viewport diff% + signals + the current verdict), `submit_verdict` (verdict kind, reasoning, optional confidence, model); **tool handlers unit-tested against a fake client** (args → client call → MCP result shape; client error → tool error)
- [ ] **Judging skill** bundled + versioned in the repo (e.g. `.claude/skills/regression-judge/SKILL.md`): encodes the procedure (enumerate → fetch → judge → submit) and the verdict taxonomy — anti-aliasing / dynamic content (carousel, timestamp) / intentional restyle = NOT a regression; broken layout / missing element / content corruption = `real_regression`; emit confidence + a one-paragraph reasoning; set `model` to the judging model id
- [ ] Docs: how to register the MCP server in an MCP client + run the skill (short section in README or docs/)
- [ ] existing `bun test`, `bun run build:web`, `bun run typecheck` all pass

## Blocked by

None — slice 02 (the verdict API + agent token) is already done.
