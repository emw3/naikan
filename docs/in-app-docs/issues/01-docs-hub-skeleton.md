# 01 — Docs hub skeleton

Status: ready-for-agent
Category: enhancement
Type: AFK

## Parent

`docs/in-app-docs/BRIEF.md`

## What to build

The thinnest end-to-end docs surface in web-admin: a `Docs` link in the sidebar (visible
to all roles) that routes to `#/docs` and renders a markdown page (Getting Started)
through a markdown renderer into a styled prose container, on-brand with the dark
Vercel/Geist look.

End-to-end demo: click `Docs` in the sidebar → the hub opens at `#/docs` → a
Getting-Started page authored as markdown renders as styled HTML that visually matches
the rest of web-admin (DESIGN.md / ADR-0007).

This slice establishes the seam every later slice builds on: the content directory, the
renderer choice, the route, the sidebar entry, and the `.prose` styling — but only one
placeholder page of content.

## Acceptance criteria

- [ ] `Docs` nav link added to the sidebar in `apps/web-admin/src/Shell.svelte`, visible to all roles (not admin-gated), with active-state handling consistent with the other navlinks
- [ ] Route `#/docs` resolves to a Docs hub view; the triad nav (Concepts / Guides / Reference) is present as scaffolding even if only Getting Started has content
- [ ] A markdown renderer (`marked` or `markdown-it`) added to `apps/web-admin` and used to render trusted in-repo markdown
- [ ] Content lives under a content dir in `apps/web-admin` (e.g. `src/docs/content/`); Getting Started authored as a markdown file, not hardcoded JSX/markup
- [ ] Rendered markdown sits in a styled `.prose` container reusing app.css tokens (headings, links, code blocks, lists) — matches dark Vercel/Geist, does not look like a different app
- [ ] No new `@naikan/*` package created; everything in `apps/web-admin`
- [ ] Existing web-admin build/lint/typecheck pass

## Blocked by

None — can start immediately.
