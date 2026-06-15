# 02 — Glossary data file + Concepts page

Status: ready-for-agent
Category: enhancement
Type: AFK

## Parent

`docs/in-app-docs/BRIEF.md`

## What to build

The single structured glossary data file plus a Concepts page in the hub that renders it,
including the hash-routing anchor contract so inline hints (slice 03) can deep-link to a
specific term.

End-to-end demo: navigate to `#/docs/concepts` → the page lists the seeded UI-check terms
with their definitions → navigating to `#/docs/concepts/diff` opens the Concepts page and
scrolls the `diff` term into view.

The glossary file is the reusable atom: slice 03's `<Hint>` reads `short` from it, and
this page renders the full list. End-user phrasing — do NOT copy CONTEXT.md's
domain-expert wording verbatim.

## Acceptance criteria

- [ ] A structured glossary data file (e.g. `apps/web-admin/src/docs/glossary.ts`) with entries shaped `{ slug, term, short, aliases?, anchor }`
- [ ] Seeded with the UI-check terms: `ui-check`, `viewport`, `baseline`, `diff`, `signal`, `check-run`, `capture` — each with end-user `short` text and a longer body for the Concepts page
- [ ] Concepts page renders every glossary entry with an anchorable element per term
- [ ] Route `#/docs/concepts/:slug` opens the Concepts page and scrolls the matching term into view on mount and on route change (the hash-routing anchor contract — a URL fragment cannot be used because the fragment IS the router input)
- [ ] Unknown `:slug` degrades gracefully (lands on Concepts top, no crash)
- [ ] Concepts page styled consistently with the hub (`.prose` / app.css tokens)
- [ ] Build/lint/typecheck pass

## Blocked by

- `docs/in-app-docs/issues/01-docs-hub-skeleton.md`
