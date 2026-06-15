<!-- Synced to the implemented build (apps/web-admin/src/app.css + views) and prototypes/vercel-redesign.html on 2026-06-04. This replaces the earlier light "Quiet Ledger" system; the reversal and its rationale are recorded in docs/adr/0007-ui-vercel-dark-direction.md. -->
---
name: Naikan Monitor
description: Internal monitoring platform — a dark, Vercel-dashboard surface. Near-black, elevated bordered panels, dense data tables, status as a colored dot + word. Calm at a glance, red the instant something breaks.
colors:
  bg: "oklch(0.10 0 0)"                       # the page — near-black ≈ #040404
  panel: "oklch(0.195 0 0)"                   # elevated card/table surface ≈ #121212
  panel-2: "oklch(0.23 0 0)"                  # table header row / inset ≈ #1a1a1a
  surface: "oklch(0.195 0 0)"                 # alias of panel (secondary-button / control surface)
  hover: "oklch(0.255 0 0)"                   # row / nav / control hover fill
  border: "oklch(0.30 0 0)"                   # structural hairline ≈ #2b2b2b (panel edge, header rule)
  separator: "oklch(0.26 0 0)"               # fainter in-list / table row rule
  border-strong: "oklch(0.40 0 0)"            # input borders, emphasized dividers
  ink: "oklch(0.96 0 0)"                       # primary text ≈ #ededed (~16:1 on bg)
  ink-muted: "oklch(0.74 0 0)"                # secondary text ≈ #a8a8a8 (≥4.5:1)
  ink-subtle: "oklch(0.60 0 0)"               # large / disabled / glyph only ≈ #808080
  steel: "oklch(0.55 0.16 250)"               # accent fill base + focus-ring base (Geist blue)
  steel-ink: "oklch(0.78 0.14 248)"           # links on dark (≥4.5:1)
  ok: "oklch(0.74 0.17 152)"                  # status dot — operational/pass/healthy
  ok-ink: "oklch(0.82 0.16 152)"              # status word — green
  ok-weak: "oklch(0.27 0.06 152)"             # tint behind an ok pill
  warn: "oklch(0.80 0.15 80)"
  warn-ink: "oklch(0.85 0.14 82)"
  fail: "oklch(0.63 0.21 25)"                 # status dot — down/fail/incident
  fail-solid: "oklch(0.58 0.22 25)"           # solid fill (run-stripe failure segment)
  fail-ink: "oklch(0.74 0.19 25)"             # status word — red
  fail-weak: "oklch(0.30 0.10 25)"
  idle: "oklch(0.62 0.012 250)"               # status dot — pending/no-data (gray)
  idle-ink: "oklch(0.70 0.012 250)"
  focus-ring: "oklch(0.65 0.18 248)"
typography:
  display:                                   # the one page title (project name / "Projects")
    fontFamily: "Inter, 'Inter-fallback', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1.625rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  title:                                     # section / panel headings
    fontFamily: "Inter, 'Inter-fallback', system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.3
  body:                                      # default UI text (dense product scale)
    fontFamily: "Inter, 'Inter-fallback', system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  sm:                                        # table cells, metadata, status
    fontFamily: "Inter, 'Inter-fallback', system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
  xs:                                        # column headers, tags, captions
    fontFamily: "Inter, 'Inter-fallback', system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
  data:                                      # machine values (latency, %, durations, paths, IDs)
    fontFamily: "'JetBrains Mono', 'SF Mono', ui-monospace, 'Cascadia Code', monospace"
    fontVariantNumeric: "tabular-nums"
rounded:
  sm: "5px"
  md: "8px"
  lg: "12px"
  full: "9999px"
spacing: { "1": "4px", "2": "8px", "3": "12px", "4": "16px", "5": "20px", "6": "24px", "8": "32px", "10": "40px", "12": "48px" }
components:
  panel:                                     # the bordered container that holds a table or grouped list
    backgroundColor: "{colors.panel}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.lg}"
    note: "panels are flat (no resting shadow); they DO NOT nest. One panel per logical group."
  table:                                     # the primary list surface
    header: "{colors.panel-2} row, {colors.ink-muted} {typography.xs} sentence-case labels, bottom {colors.border} rule"
    row: "{typography.sm}; 1px {colors.separator} between rows; hover {colors.hover} on interactive rows; numeric + machine columns are {typography.data}, right-aligned"
    note: "real <table> with a header row; horizontally scrollable inside its panel on narrow screens (min-width 600)"
  status:                                    # the signature — a colored dot + a WORD on every row
    layout: "dot ({colors.<state>}) + label ({colors.<state>-ink})"
    states: "ok=Operational/Healthy/Pass · warn=Degraded · fail=Down/Failing/Incident/Open (dot gains a soft glow) · idle=Pending/No data"
    note: "the WORD is the non-color cue → WCAG AA, survives grayscale & color-blindness. Green DOES appear on healthy rows."
  tile:                                      # overview summary stat
    backgroundColor: "{colors.panel}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.lg}"
    note: "small label + big tnum value; a row of these summarizes a project (status / incidents / checks / uptime)"
  button-primary:                            # white fill, dark text (Vercel signature)
    backgroundColor: "{colors.ink}"
    textColor: "{colors.bg}"
    rounded: "{rounded.md}"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    border: "1px solid {colors.border-strong}"
  input:
    backgroundColor: "{colors.bg}"           # inset: darker than the panel it sits in
    border: "1px solid {colors.border-strong}"
    focus: "border → {colors.steel} + 2px {colors.focus-ring}"
  sidebar:
    note: "left rail on {colors.bg}, 1px right border; collapses below 880px into an off-canvas drawer (hamburger in the topbar + dimming backdrop)"
---

# Design System: Naikan Monitor

## 1. Overview

**Creative North Star: "The Operator's Console"**

The team trusts this tool to wake them up, so it reads like the dashboards operators already live in (Vercel, Linear): a quiet near-black surface where structured data sits in clean tables, and the one thing that's broken is the only thing wearing color. You scan a screen in seconds because everything is aligned, dense, and unornamented; you drill in with one click.

The system is the **Vercel dashboard (Geist) direction**: a near-black page (`bg ≈ #040404`), content held in **elevated, 1px-bordered panels**, real **data tables** for list surfaces, small precise type, and monospace for machine values. Status is communicated everywhere as a **colored dot + a word** ("Operational", "Down", "Pending"). One steel-blue accent is reserved for links, focus, and the brand mark; the primary action button is a white fill with dark text.

This direction was adopted in **ADR-0007**, replacing the earlier light, table-free "Quiet Ledger". It still rejects the four things in the product brief — the **generic SaaS template** (gradient hero cards, purple gradients), **observability overload** (the wall-of-widgets where the broken thing is buried), **consumer-cute** (mascots, bouncy motion), and the **flat-gray admin** (an unstyled Bootstrap table with no status discipline) — but it embraces dense, ordered tables as the right tool for an operator's triage.

**Key Characteristics:**
- Dark, near-black surface; structure from elevated bordered **panels** + **tables**, not flat space.
- Data lives in real tables (header row + aligned columns); the per-project **overview** is a summary (stat tiles + a checks table), not a raw dump.
- Status everywhere is a **dot + word**; red/amber dominate the neutral field even though healthy rows show a green dot.
- Type-led density on a small product scale; sans for the interface, mono for machine values.
- One steel-blue accent (links / focus / brand); white primary button.
- Status never relies on color alone — the word is always present (WCAG 2.1 AA, color-blind safe).

## 2. Colors

A near-black neutral ramp, one steel-blue accent, and a status palette that is the only place vivid color lives.

### Surfaces (true-neutral dark ramp)
- **bg** (`oklch(0.10 0 0)`): the page, the sidebar, the topbar base. Near-black.
- **panel** (`oklch(0.195 0 0)`): the elevated surface for every card and table. The page reads as panels floating on the near-black bg, separated by 1px borders.
- **panel-2** (`oklch(0.23 0 0)`): the table header row and inset wells (one step up from panel).
- **hover** (`oklch(0.255 0 0)`): the transient fill for an interactive row, nav item, or control.
- **border** (`oklch(0.30 0 0)`) / **separator** (`oklch(0.26 0 0)`) / **border-strong** (`oklch(0.40 0 0)`): the structural hairline, the fainter in-table row rule, and input/emphasis dividers.

### Ink
- **ink** (`oklch(0.96 0 0)`): primary text (~16:1 on bg). **ink-muted** (`0.74`): secondary text, ≥4.5:1 — the floor for real text. **ink-subtle** (`0.60`): large/disabled/glyph only, never body copy.

### Steel (the one accent)
- **steel** (`oklch(0.55 0.16 250)`): focus-ring base, brand mark. **steel-ink** (`0.78 0.14 248`): links on dark. The accent is for links, focus, and "you are here", not for primary actions (the primary button is white).

### Status (semantic — the heart of the tool)
Color is meaning, never decoration. Hues spread wide (25 / 80 / 152 / 250) so they survive grayscale and color-vision deficiencies. Each state is a **dot** (solid) + a **word** (the `-ink` shade, ≥4.5:1 on panel).
- **OK / Operational / Pass / Healthy** — green. dot `oklch(0.74 0.17 152)`, word `0.82 0.16 152`.
- **Warn / Degraded** — amber. dot `0.80 0.15 80`, word `0.85 0.14 82`.
- **Fail / Down / Failing / Incident / Open** — red. dot `0.63 0.21 25` (with a soft glow ring), solid `0.58 0.22 25`, word `0.74 0.19 25`.
- **Idle / Pending / No data** — gray. dot `0.62 0.012 250`, word `0.70 0.012 250`.

### Named Rules
**The Panel Rule.** Content lives in elevated, 1px-bordered, rounded panels on the `bg`. Panels are flat (no resting shadow) and **never nest** — one panel per logical group.

**The Status-Dot Rule.** Every status is a colored dot **plus a word**. Green appears on healthy rows; red/amber still win the eye because the field is otherwise neutral.

**The Color-Plus-Word Rule.** The word is the non-color cue, so status survives grayscale and color-blindness. Never communicate state with the dot alone.

**The One Blue Rule.** Steel-blue is the only non-status color — links, focus ring, brand. The primary action is a white button, not a blue one.

**The Status-Owns-Color Rule.** A vivid pixel that is not steel-blue is communicating status. No decorative greens, ambers, or reds.

## 3. Typography

**Interface:** Inter (with a metric-matched `Inter-fallback`, then `system-ui`). **Machine data:** JetBrains Mono, tabular figures on. (Inter is visually ~equivalent to Geist Sans and is already wired with a zero-CLS fallback; see ADR-0007 for why the fonts did not change in the dark migration.)

Density is higher than a marketing surface: **body is 14px**, table cells/metadata 13px, column headers/tags 12px. Hierarchy comes from size + weight + color, not a second face. Monospace appears only for machine values (latency, %, durations, URLs/paths, IDs) and aligns digits into scannable columns.

### Named Rules
**The Mono-Means-Machine Rule.** Mono iff the text is a machine value. Never mono for prose/labels/headings.

**The No-Uppercase-Header Rule.** Table column headers and labels are sentence-case `ink-muted`, not uppercase tracked eyebrows. Uppercase is reserved for short badges only.

## 4. Elevation

**Mostly flat.** Panels carry a 1px border and a fill step, not a shadow. Shadow is reserved for things that genuinely float: the mobile nav **drawer**, popovers/dropdowns, and modals. The topbar uses a translucent `bg` + `backdrop-filter: blur` so content scrolls under it.

## 5. Components

### Panel
The bordered container (`panel` fill, `border` hairline, `r-lg`) that holds a table or a grouped list. Optional `panel-head` (title + count chip + actions/search). Panels do not nest.

### Data Table (`.tbl`)
The primary list surface — Projects, Incidents, Users, a site's Checks, a check's Run history. Header row on `panel-2` with `ink-muted` sentence-case `xs` labels; rows separated by a `separator` hairline; interactive rows take a `hover` fill (and a chevron). Numeric/machine columns are mono, tabular, right-aligned (`.num`). Wrapped in `.tbl-wrap` so the table scrolls horizontally inside its panel on narrow screens (`.tbl` has `min-width: 600px`). **`.main` carries `min-width: 0`** so a wide table scrolls instead of widening the page.

### Status (`.status`, signature)
A colored `dot` + a word, on every row that has a state. `ok`/`warn`/`fail`/`idle` color both; the `fail` dot gains a soft glow ring. Always renders the word (no dot-only states).

### Stat Tiles (`.tiles` / `.tile`)
The single-project overview summary: a responsive row of small bordered tiles (Status / Open incidents / Checks / Uptime), each a `label` + a big tabular value. Collapses 4→2→2 columns down to mobile.

### Run stripe
On a check detail, a compact row of one segment per run (oldest→newest): green (`ok` mixed toward bg) for pass, `fail-solid` for fail. A legitimate density tool in this direction (it was banned in the old system; ADR-0007 lifts that).

### Buttons / Actions
- **Primary**: white (`ink`) fill, dark (`bg`) text, `r-md` — the Vercel signature. Reserved for the main create action and state-screen CTAs.
- **Secondary**: `panel` fill + `border-strong` hairline. **Ghost**: transparent, `ink-muted`, hover `hover` fill. **Danger**: ghost that goes `fail` on hover; used for destructive confirms (inline, never a modal-first reflex).
- All: 120ms ease-out, focus-visible → 2px `focus-ring` at 2px offset.

### Inputs
`bg` surface (inset — darker than the panel around them), `border-strong` hairline, `r-md`, `ink` text, `ink-muted` placeholder (≥4.5:1). Focus → border to steel + 2px `focus-ring`.

### Shell — Sidebar, Topbar, Drawer
Left **sidebar** on `bg` with a 1px right border; the active item gets a `panel` fill (not just colored text). **Topbar** on a translucent blurred `bg` with a bottom hairline; brand at left, user + log-out at right. Below **880px** the sidebar becomes an **off-canvas drawer**: a hamburger in the topbar opens it over a dimming backdrop (tap-out or Esc closes; navigating closes it). Honors `prefers-reduced-motion`.

### Loading / Empty / Error
Empty/error states are a muted teaching sentence inside the panel where the table would be. Status screens (login, full-page load) center on `bg`.

## 6. Do's and Don'ts

### Do:
- **Do** keep the near-black `bg`; put content in elevated 1px-bordered **panels**.
- **Do** use real **tables** for list surfaces (Projects, Incidents, Users, Checks, Run history); keep the single-project **overview** as stat tiles + a checks table.
- **Do** render every status as a **dot + word**; keep AA contrast and the word as the non-color cue.
- **Do** keep the One Blue Rule (links/focus/brand only) and the white primary button.
- **Do** use mono for machine values; commit to the dense product type scale.
- **Do** wrap tables in `.tbl-wrap` and keep `.main { min-width: 0 }` so wide tables scroll, not the page.
- **Do** give interactive elements default / hover / focus-visible / disabled / loading states; teaching empty states; honor `prefers-reduced-motion`.

### Don't:
- **Don't** nest panels, or stack a card inside a card. One panel per group.
- **Don't** communicate status with a dot (or color) alone — the word is mandatory.
- **Don't** use color decoratively — a vivid pixel that is not steel-blue must mean a status.
- **Don't** make the primary action blue; it's the white button. Blue is links/focus/brand.
- **Don't** use uppercase tracked eyebrows or uppercase column headers; sentence-case `ink-muted`.
- **Don't** let a wide table widen the page (fix the grid item's `min-width`, scroll inside the panel instead).
- **Don't** add resting shadows to panels; shadow is for floating layers (drawer, popover, modal) only.
- **Don't** reach for a modal first; exhaust inline + progressive disclosure. Reserve modals/confirms for destructive actions.
