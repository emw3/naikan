# Product

## Register

product

## Users

Internal Naikan staff only. No project-facing surfaces in MVP.

- **Account managers** — own a portfolio of assigned projects. Open the tool at the start of the day to scan "what changed across my projects in the last 24h" in ~30 seconds, then drill into anything that regressed. Receive the daily digest by email/Slack and deep-link from it into detail pages. Care about: is anything broken right now, and is this regression real or noise.
- **Developers** — investigate failures, correlate a heartbeat timeline or perf trend with a deploy or external event, decide whether a screenshot diff is a real break.
- **Admins** — configure the monitoring: create projects, sites, checks, and check-groups; approve baselines; manually trigger a check to validate a config change; manage users and roles.
- **Viewers** — read-only across all projects; answer "is project X OK right now" and pull uptime/incident history when asked.

Context of use: a desk, internal network, during the workday. The tool runs unattended; humans arrive to triage, not to babysit. Two flat roles (Admin = CRUD, Viewer = read); managers are scoped to their assigned projects on read surfaces.

## Product Purpose

Naikan Monitor is a configure-once, run-automatically platform that watches a portfolio of project websites so the team finds out about breakage proactively instead of from the project. Per project it runs **heartbeat checks** (every 5–15 min: HTTP status, body assertion, SSL validity, DNS) and daily **UI checks** (three viewports, baseline screenshot diff, plus synthetic signals: page-load, console errors, required selectors, Web-Vitals budget).

When a heartbeat fails N consecutive times it opens an **Incident** and pages someone in realtime (email + Slack, per-project routing); incidents auto-close after recovery and send a "recovered after N minutes" alert. Noisy UI signals (visual regression, console errors, perf) roll into a **daily digest** instead of paging at 3am. Every morning each manager gets a digest of their projects' last 24h with deep links to detail. The platform monitors itself via a `/health` endpoint polled by an external uptime service.

Success: the team learns about real outages within minutes, triages regressions from a single shared surface in seconds, and is not woken up for a hero-image change.

## Brand Personality

**Clean utility.** Light, neutral, no-nonsense internal tooling that gets out of the way. Confident and precise, not decorated. The voice is plain and operational: it states status, it doesn't sell. Calm when everything is green; unmistakable when something breaks. Trust comes from consistency and legibility, not from visual flourish.

Three words: **clear, calm, precise.**

"Clean utility" here is the disciplined kind, not the lazy kind — see the explicit ban on flat-gray-admin below. Neutral surfaces, real typographic hierarchy, and reserved status color, not an unstyled table dump.

## Anti-references

This should NOT look like any of these:

- **Generic SaaS template** — gradient hero-metric cards, identical icon+heading+text card grids, purple gradients, marketing-y dashboard clichés. This is an internal ops tool, not a landing page.
- **Enterprise observability overload** — the Datadog/Splunk wall-of-widgets where every pixel is a chart and the one thing that's broken is buried. Density must serve triage, never bury it.
- **Consumer-cute** — mascots, playful illustrations, rounded-everything, bouncy motion, emoji-as-status. Too casual for a tool people trust to page them.
- **Flat gray admin** — the lifeless Bootstrap-era gray table with no status-color discipline and no hierarchy: the "internal tool nobody styled" look. Clean utility is the goal; this is its failure mode.

## Design Principles

1. **Status is the loudest thing.** The one check that's broken must out-shout everything else on the screen; an all-green state is restful and quiet. Visual weight follows severity, not layout convenience.
2. **Built for the 30-second scan, then the drill-down.** The primary read path is fast triage at the overview/digest level; full detail (timelines, diffs, perf trends) is one click deeper. Progressive disclosure, never everything at once.
3. **Density without clutter.** This is genuinely data-dense (run stripes, 24h timelines, per-viewport diff viewers, per-signal status). Show it, but with rhythm and hierarchy so it reads as structure, not noise. Reject the wall-of-widgets.
4. **Color means state, nothing else.** Color is reserved as a signal for pass / fail / warning / incident, never used decoratively. Every status pairs color with shape, icon, or label so it survives color-blindness, grayscale, and a glance.
5. **Trust through precision.** Confidence comes from consistent components, accurate data, and exact alignment — not decoration. If a number or a diff is shown, it must be unambiguous and correct-looking.

## Accessibility & Inclusion

- **Target: WCAG 2.1 AA.** Body text ≥4.5:1 contrast, large text ≥3:1, visible focus states, semantic markup, keyboard-operable controls.
- **Status never relies on color alone.** Pass/fail/warning/incident are always reinforced with an icon, shape, or text label (directly supports Principle 4 and red/green color-blindness). The status palette is chosen to remain distinguishable in common color-vision deficiencies.
- **Reduced motion is honored.** Respect `prefers-reduced-motion`; no animation is ever required to understand state — motion only enhances an already-legible default (crossfade/instant fallback).
