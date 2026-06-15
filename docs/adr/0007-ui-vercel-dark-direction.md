---
status: accepted
---

# The web-admin UI moves from the light "Quiet Ledger" to a dark Vercel-dashboard direction

The web-admin design system is replaced. The previous direction — DESIGN.md's
**"The Quiet Ledger"**: one light near-white flat surface, no cards, no data tables, an
airy two-line row list, and a *silent-green / loud-red* signature — is retired. The new
direction is the **Vercel dashboard (Geist)** look: a dark near-black surface
(`bg ≈ #0a0a0a`) with elevated bordered panels, real data tables (header row + columns)
for the list surfaces, small dense type, monospace for IDs and machine values, and a
colored-dot + word status badge on every row.

This reverses a direction that was itself confirmed only days earlier (DESIGN.md was
synced to `prototypes/project-overview.html` on 2026-06-01 after several rounds). It is a
deliberate, owner-driven reversal, not drift.

## Why

- The owner (Gustavo) decided the light editorial surface should become a dark, ordered,
  table-led product surface modeled on the Vercel dashboard. This was the explicit ask
  ("make it look like vercel, dark background, tables, order, well organized").
- The Vercel **dashboard** (not the marketing site) was chosen as the reference: it is a
  real operator UI built for scanning dense data, which fits an internal triage tool far
  better than the hero-driven marketing aesthetic.
- Tables are adopted **selectively**, where data is genuinely tabular and comparable —
  Projects portfolio, Checks, Run history, Incidents, Users. The single-project **overview**
  stays a status-summary (header + grouped panels), because its job is a 30-second
  "what's broken" scan that a raw table degrades. This mirrors how Vercel's own dashboard
  splits list views (tables) from a project's overview (summary).
- Two things survive the reversal because they are **product requirements, not aesthetic
  preferences** (both stated in PRODUCT.md, independent of any design system):
  - *Status is the loudest thing* (Principle 1) — preserved by hue: red/amber still
    dominate the neutral dark field even though healthy rows now show a green dot.
  - *Status never relies on color alone* (Principle 4, WCAG 2.1 AA) — every status is a
    colored dot **plus a word** ("Operational" / "Degraded" / "Down" / "Pending"), so the
    word is the non-color cue. AA contrast on the dark surface is re-verified.

## Considered options

- **Evolve the Quiet Ledger** (go dark + add tables but keep silent-green/loud-red as the
  signature). Rejected by the owner — wanted the literal Vercel dashboard look, including
  green status on healthy rows, not a hybrid.
- **Dark reskin only** (flip the palette, keep the table-free airy rows). Rejected — the
  explicit ask was for tables and a more "ordered" structure, which the airy-row system
  deliberately avoided.
- **Marketing-site Vercel** (pure black, huge display type, gradients, geometric hero
  motifs). Rejected — built to impress visitors, fights the data-dense 30-second-scan goal
  of an internal ops tool.

## Consequences

- **DESIGN.md is rewritten** end-to-end against the new dark token set and components
  (tables, panels, status-dot badge), and re-synced to the new reference prototype
  (`prototypes/vercel-redesign.html`). The old "no cards / no tables / no uppercase header /
  no-dot-on-healthy-row" bans are removed; new constraints replace them (selective tables,
  panels-not-nested-cards, dot+word a11y floor, hue-carries-severity).
- **`apps/web-admin/src/app.css` tokens flip to a dark ramp.** `color-scheme: dark`. The
  OKLCH token names are largely reused (`--bg`, `--panel`/`--surface`, `--border`, `--ink*`,
  `--ok/warn/fail/idle`) so component CSS migrates token-by-token rather than wholesale.
- **Rollout is tokens-first, then view-by-view** across the 10 views (Shell → Projects →
  detail pages), each independently verifiable, rather than one large diff.
- **Fonts are unchanged** (Inter + JetBrains Mono): Inter is visually ~equivalent to Geist
  Sans and already wired with a zero-CLS metric fallback, so the authenticity gain of
  switching did not justify re-tuning the fallback.
- A portfolio **Status** column needs data the current `GET /api/projects` does not return
  (per-project aggregate state + open-incident count). Either extend that endpoint or add a
  portfolio endpoint; tracked as a follow-up to the visual rollout.
- The prior memory note `ui-aesthetic-direction` (which recorded the light/no-cards/no-table
  preference) is updated to record this reversal so future sessions do not re-apply the
  Quiet Ledger.

---

*Originated from a `/grill-with-docs` session redesigning the web-admin UI. ADR number 0007:
0004 stays reserved for #19 (IaC tool) per ADR-0005's numbering note.*
