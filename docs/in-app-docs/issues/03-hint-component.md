# 03 — `<Hint>` popover component + one wired field

Status: ready-for-agent
Category: enhancement
Type: AFK

## Parent

`docs/in-app-docs/BRIEF.md`

## What to build

The accessible inline-hint affordance — a reusable `<Hint slug="…">` component rendering a
keyboard-focusable `?` button that opens a popover with the glossary `short` plus a
"Learn more →" deep-link into the hub. Wire it onto ONE field on `UICheckDetail.svelte` as
the tracer.

End-to-end demo: on the UI-check detail page, focus or click the `?` next to the tracer
field → a popover shows that term's `short` definition → "Learn more →" navigates to
`#/docs/concepts/<slug>` and scrolls the term into view (proves slice 02's contract).

This is the cross-view affordance every other surface will reuse later; build it for
accessibility and reuse, not just the one field.

## Acceptance criteria

- [ ] `<Hint slug="…">` component in `apps/web-admin/src/lib/` (or a docs lib dir)
- [ ] Reads `short` and `term` from the slice-02 glossary file by `slug`; fails loudly in dev if the slug is unknown
- [ ] `?` trigger is a real focusable button: keyboard-operable (Enter/Space to open, Esc to close), `aria-describedby`/`aria-expanded` wired, focus visible
- [ ] Popover shows `short` + a "Learn more →" link to `#/docs/concepts/<slug>`
- [ ] Honors `prefers-reduced-motion` (no required motion; instant/!crossfade fallback); meets WCAG 2.1 AA contrast
- [ ] Popover styling matches the dark Vercel/Geist system (app.css tokens), positioned so it does not clip in dense tables
- [ ] Wired onto exactly one `UICheckDetail.svelte` field as the tracer
- [ ] Build/lint/typecheck pass

## Blocked by

- `docs/in-app-docs/issues/02-glossary-and-concepts.md`
