# In-app documentation — feature brief

Scoped via a `grill-with-docs` session on 2026-06-04. This brief is the shared design
context for every issue under `docs/in-app-docs/issues/`. An agent grabbing any
single issue should read this first.

## Goal

Add in-app documentation to web-admin so internal staff (Account managers, Developers,
Admins, Viewers) can learn how every field, form, check, UI check, and status works —
with Stripe/Vercel-grade *polish* applied to an internal ops tool. Not an external API
portal (PRODUCT.md: no project-facing surfaces).

## Locked decisions

1. **Shape — hub + linked inline hints.** A dedicated `Docs` section in the sidebar is
   the single source of truth. Inline `?` affordances on fields/columns/sections
   **deep-link into** the hub. No duplicated copy — hints point INTO the hub.
2. **Audience — all 4 internal roles.** "Developer experience" = docs polish, not an
   external developer portal.
3. **Content source — markdown in repo + one structured glossary data file.** Guide
   pages are markdown files (PR-reviewed, version-controlled). The glossary is ONE
   structured data file (`{ slug, term, short, aliases?, anchor }`) consumed by BOTH the
   hub Concepts page AND the inline `?` hints. No DB, no runtime CMS.
4. **Hint UX — `?` → accessible popover.** Keyboard-focusable `?` button; click/focus
   opens a popover with the glossary `short` + a "Learn more →" deep-link into the hub.
   Config forms ALSO get persistent helper text under inputs. WCAG 2.1 AA, honors
   `prefers-reduced-motion`, `aria-describedby`.
5. **Hub IA — Concepts / Guides / Reference triad** (Diátaxis) + a short Getting Started.
   Inline hints anchor into Concepts + Reference.
6. **v1 scope — tracer bullet.** Build the WHOLE machinery, but populate content
   end-to-end for ONE surface first: the **UI-check detail** (`UICheckDetail.svelte` —
   richest/most confusing: viewports, baselines, diffs, signals). Fan out to other views
   in follow-up slices later.
7. **Drift guard — lightweight test.** A unit test asserts every inline `?` slug resolves
   in the glossary file and intra-doc links resolve. Defer the heavier
   "does this documented field still exist in the form" cross-check.

## Rejected alternatives

- DB / runtime-editable CMS (overkill for an internal tool; needs editor UI + auth).
- Inline hints carrying their own copy (guaranteed drift — two sources of truth).
- IA by UI-surface or by role (duplicates concepts; no canonical home for a term).
- Big-bang full coverage before shipping (delays all value, content drifts pre-launch).
- Generating in-app docs from CONTEXT.md/PRODUCT.md (those are domain-expert/product
  facing — different purpose + tone; coupling constrains both).
- External/project-facing portal architecture (contradicts "no project-facing surfaces").

## Implementation notes / contracts

- **Hash-routing anchor contract.** web-admin uses hash routing (`location.hash` in
  `Shell.svelte`). A plain `#anchor` fragment IS the router's input, so hint deep-links
  CANNOT use URL fragments. Encode the target IN the route: `#/docs/concepts/diff`, and
  the Concepts page scrolls the `diff` term into view on mount/route-change.
- **Location.** Lives in `apps/web-admin` (content dir + small docs lib). No new
  `@naikan/*` package — only web-admin consumes it; extraction is premature.
- **Renderer.** `marked` or `markdown-it` rendering trusted in-repo markdown into a
  styled `.prose` container. No MDX/mdsvex (avoids build complexity for static content).
- **Styling.** Follow DESIGN.md + ADR-0007 (dark Vercel/Geist). Reuse existing app.css
  tokens; the docs surface must not look like a different app.
- **Search.** Deferred for v1 (surface too small).
- **Glossary seed (UI-check terms, from CONTEXT.md):** `ui-check`, `viewport`,
  `baseline`, `diff`, `signal`, `check-run`, `capture`. Re-phrase for end users; do NOT
  couple to CONTEXT.md's domain-expert wording.

## Slices

1. Docs hub skeleton — sidebar link + route + markdown renderer + Getting Started.
2. Glossary data file + Concepts page (with the hash-routing anchor scroll).
3. `<Hint>` popover component + one wired UICheckDetail field (tracer).
4. Full UI-check content + hints across the surface (Guide + Reference + all hints + form helper text).
5. Drift-guard test (hint slugs + doc links resolve).
