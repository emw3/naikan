# PRD — Agentic regression-judge

Status: needs-triage

The platform's own AI layer: an agent that judges whether a UI **Check run**'s
screenshot **Diff** is a *real* visual regression or noise, reached through a
bundled **MCP server** + **skill**, with its **verdict** written back into the
product and an **eval suite** proving the judgment holds up. This is the agentic
hook that distinguishes Naikan from a plain monitor.

## Problem Statement

Today a human is the only thing standing between a noisy screenshot **Diff** and a
wrong call. A UI **Check run** captures three **Viewports**, diffs each against its
approved **Baseline**, and judges four **Signals** — but the visual diff itself is
just a differing-pixel percentage. A 0.4% diff might be a genuinely broken nav bar
or just anti-aliasing, a rotated carousel, or a timestamp that ticked. The admin who
opens the run detail must eyeball baseline | current | diff and decide whether to
promote-to-**Baseline**, and that judgment is exactly the tedious, high-volume,
easy-to-get-wrong work that erodes trust in visual checks (teams disable them within
a few sprints precisely because the noise buries the real breaks).

There is no second opinion, no explanation captured, and no record of *why* a diff
was or wasn't a regression — so the signal never improves and the reviewer never
gets leverage.

## Solution

Naikan judges its own visual diffs. An AI agent — driven by a **skill** the platform
ships, talking to the platform through an **MCP server** the platform also ships —
reads a UI run's baseline/current/diff images plus its **Signals**, classifies the
diff as a real regression, noise, an intentional change, or uncertain, explains its
reasoning, and records that **verdict** against the run. The run-detail view then
shows the agent's verdict as a badge right next to the human's promote-to-**Baseline**
action: the agent advises, the human still decides. Nothing auto-promotes.

Because the whole point is *trustworthy* judgment, the feature ships with an **eval
suite**: a labeled golden dataset of diffs, a grader that scores the agent's verdicts
against ground truth, a regression test that fails if accuracy drops below a
threshold, and a published writeup (`EVALS.md`) of precision/recall and the failure
modes found. The judgment is measured, not asserted.

## User Stories

1. As an **admin** reviewing a UI **Check run**, I want an AI **verdict** (real regression / noise / intentional / uncertain) shown next to the diff, so that I can triage a borderline diff in seconds instead of squinting at three viewports.
2. As an **admin**, I want the agent's plain-language **reasoning** for its verdict, so that I can sanity-check the call rather than trust a black-box label.
3. As an **admin**, I want the agent's self-reported **confidence**, so that I know when to look harder myself.
4. As an **admin**, I want the verdict to never auto-promote a **Baseline**, so that the human stays the authority on what "correct" looks like.
5. As an **account manager**, I want noisy diffs the agent labels "noise" to be visually de-emphasised, so that my 30-second scan surfaces the real regressions first.
6. As a **developer/agent author**, I want the platform to expose its UI runs and accept verdicts over an **MCP server**, so that an agent (Claude or any MCP client) can judge regressions without bespoke integration.
7. As a **developer/agent author**, I want a bundled **skill** that encodes how to judge a diff, so that the judging behaviour is reproducible and versioned in the repo, not improvised per session.
8. As an **agent**, I want to enumerate UI checks and their recent runs over MCP, so that I can find the runs that need a verdict.
9. As an **agent**, I want to fetch one run's baseline/current/diff images, diff percentages, and **Signals** over MCP, so that I have everything needed to judge it.
10. As an **agent**, I want to submit a verdict (kind, confidence, reasoning, model) for a run over MCP, so that my judgment is persisted in the product.
11. As an **operator**, I want the agent to authenticate with a **scoped token** that can read runs and write verdicts but cannot mutate config, so that a leaked agent credential can't delete a Project or manage users.
12. As an **operator**, I want the platform to boot and serve normally when no agent token is configured, so that the agent is strictly opt-in.
13. As a **maintainer**, I want a labeled golden dataset of diffs (real regressions, noise, intentional changes), so that the judge's accuracy can be measured.
14. As a **maintainer**, I want an eval harness that scores verdicts against ground truth and reports precision/recall + a confusion breakdown, so that I know how good the judge actually is.
15. As a **maintainer**, I want a regression test that fails when judge accuracy drops below a threshold, so that a prompt or model change can't silently degrade judgment.
16. As a **maintainer**, I want the eval methodology, metrics, and failure modes published in `EVALS.md`, so that the judgment is transparent and the limitations are stated.
17. As a **reviewer of the project**, I want to run the judge end-to-end against seeded data, so that I can see a real regression and a noise diff judged correctly without setup.
18. As an **agent author**, I want repeated verdicts on the same run preserved (history), so that I can compare models or re-judges over time.

## Implementation Decisions

**Already implemented (reference, not future work):**

- **AgentVerdict** entity + `agent_verdicts` table — `runId` (FK → check_runs, cascade), `verdict` ∈ {`real_regression`, `noise`, `intentional`, `uncertain`}, nullable `confidence` (0..1), `reasoning`, `model` (provenance), `createdAt`. Multiple verdicts per run kept; latest surfaced. Agent-generated telemetry — **not audited** (mirrors CheckRun / Incident). Store methods on the `ConfigStore` (`insert`/`listByRun`/`latestByRun`), repo methods `recordVerdict` (validated) / `getLatestVerdict` / `listVerdicts`. *(commit a71491c)*
- **Verdict API + scoped agent auth** — `POST /api/uichecks/:id/runs/:runId/verdict`; the run-detail GET now returns the latest verdict. `requireAuth` accepts a configured `NAIKAN_AGENT_TOKEN` bearer (constant-time compare) resolving to a read-only **agent principal** (a `viewer`); scoping is **by role** (the token authenticates everywhere but the admin gate returns 403, never 401), so the agent reads + records verdicts but cannot mutate config. No token configured → session-only, platform still boots. *(commit 67d1362)*

**To build:**

- **`@naikan/mcp` server** — a stdio MCP server the platform ships. Two layers: a deep **API client** (a typed fetch wrapper over the HTTP API, carrying the agent bearer token + base URL, with a small surface — list UI checks, list runs for a check, get one run's detail, submit a verdict) and an **MCP tool layer** that exposes `list_ui_checks`, `list_ui_runs`, `get_ui_run`, `submit_verdict`. Config via env (`NAIKAN_API_URL`, `NAIKAN_AGENT_TOKEN`). Transport: stdio (the agent runs it locally).
- **Discovery endpoint** — `GET /api/uichecks` returns the flat list of UI checks visible to the caller (manager-scoped), so the MCP `list_ui_checks` tool has a single call to enumerate. Backed by a new repo method `listAllUIChecks()` over the store's existing `uichecks.listAll()`.
- **Judging skill** — a bundled skill (prompt artifact, versioned in the repo) that tells an agent the judging procedure: pick a run via the MCP tools, fetch its baseline/current/diff images + diff% + Signals, classify the diff into the four verdict kinds with confidence + reasoning, and `submit_verdict`. Encodes the failure taxonomy (anti-aliasing / dynamic content / intentional redesign vs. genuine layout/content breaks).
- **web-admin verdict badge** — the run-detail view renders the latest verdict (already present in the run-detail response) as a status badge next to promote-to-Baseline, with the kind, confidence, model, and reasoning on hover/expand. Adds an `AgentVerdict` type + a `verdict` field to the SPA's run-detail type. The human promote action is unchanged.
- **Eval golden-dataset fixtures** — a **hybrid** labeled corpus: mostly **synthetic** cases generated by capturing deterministic seed pages through the real UI pipeline (a page that genuinely breaks layout = `real_regression`; a page with rotating/dynamic content = `noise`; an intentional restyle = `intentional`), plus a few **curated** real cases for credibility. Each fixture carries baseline + current + diff + Signals + a ground-truth label. Doubles as the demo seed.
- **Eval harness + `EVALS.md`** — a deep `runEval(dataset, judge)` that runs the judge over the dataset and returns precision, recall, a confusion matrix, and the misjudged cases; a **regression test** asserting accuracy ≥ a documented threshold; and `EVALS.md` publishing the dataset/grader/harness design, the metrics, and the failure modes. Binary-leaning grading (was the verdict correct vs ground truth), transcripts inspectable.

**Cross-cutting decisions:**

- Verdict kinds are fixed at four; the DB CHECK constraint and the repo validation are the single source of truth.
- Human-in-the-loop is a hard rule: the agent records advisory verdicts; only a human promote-to-Baseline changes what "correct" is.
- The agent's intelligence lives in the **MCP client (Claude) + skill**, never in the platform runtime — no LLM/API key baked into the worker or API.

## Testing Decisions

Good tests here pin **external behaviour** through the same injected-dependency seams the codebase already uses (live fetch / live store passed in, faked in tests), never implementation details. Table-driven where the input space is enumerable.

- **MCP API client** — unit-tested against a **fake fetch**: each method issues the right request (path, method, bearer header) and maps the response to the typed result. Prior art: `@naikan/heartbeat-runner` (injected `fetch`), `@naikan/alerter` (recorded fake channels).
- **MCP tool handlers** — unit-tested with a **fake client**: each tool maps its arguments to a client call and returns the right MCP content shape; errors surface as tool errors.
- **`GET /api/uichecks` discovery endpoint** — route test mirroring `apps/api/.../uicheck` route tests: 401 unauthenticated, 200 listing, and **manager scoping** (a manager sees only their Projects' checks; admin/unassigned-viewer see all).
- **`listAllUIChecks` repo method** — config-repo test mirroring the existing `listAll` / table-driven repo tests.
- **Eval harness `runEval`** — unit-tested with a **fake judge** over a tiny in-line fixture set: deterministic precision/recall/confusion math, and correct collection of misjudged cases.
- **Eval regression test** — the threshold guard: fails if measured accuracy on the golden dataset drops below the documented bar.
- **Not unit-tested** (by convention): the **judging skill** (a prompt — its quality is measured by the eval suite, not a unit test) and the **verdict badge** (web-admin has no unit tests in this repo; covered by build + svelte-check + the eval/demo). This matches the existing split where web-admin relies on typecheck/build rather than unit tests.

## Out of Scope

- **Auto-remediation / auto-promote** — the agent never promotes a Baseline or closes an Incident; advisory only. (Possible future feature.)
- A **built-in LLM in the worker/API runtime** — judgment stays in the MCP client + skill; no API key in the platform runtime.
- **Write actions beyond verdicts** over MCP (ack-incident, run-now, promote) — out of scope; the agent token is read + verdict only.
- The broader **open-source launch** (LICENSE, README rewrite, badges, CONTRIBUTING/SECURITY/CoC, git-history rewrite, GitHub publish, flagship blog post) — a **separate feature**, not this PRD.
- A **hosted public demo** — roadmap; this feature ships the local one-command demo seed only.

## Further Notes

Context for prioritisation (not product scope): this feature is the agentic hook for
open-sourcing Naikan as a portfolio piece toward an agentic-developer role. Deep
research found that for that goal the **eval suite is the single highest-leverage
artifact** — the canonical "agent app + MCP server + LLM-as-Judge eval suite with a
regression test" is exactly what hiring pipelines look for, and a published
precision/recall on a real judgment task is what converts "neat demo" into "senior
judgment." That is why the eval harness + `EVALS.md` (issues 06–07) are first-class
deliverables of this feature, not an afterthought. The verdict badge is also the
human-in-the-loop story (a human can always override the agent), which the same
research flags as a key seniority signal. The decided plan + research live in memory
`naikan-oss-plan.md`.
