# 04 — Full UI-check content + hints across the surface

Status: ready-for-agent
Category: enhancement
Type: AFK

## Parent

`docs/in-app-docs/BRIEF.md`

## What to build

The "very descriptive" content pass for the one tracer surface, completing the vertical:
a Guide walkthrough, a Reference covering every field/column/status on the UI-check
detail, `<Hint>` wired onto all remaining fields/columns/sections there, and persistent
helper text in its config form.

End-to-end demo: on `UICheckDetail.svelte`, every field, table column, and status has a
working `?` hint that deep-links into the hub; the hub has a Guide ("investigate a
UI-check diff") and a Reference page documenting each UI-check field/column/status; the
config form shows persistent helper text under its inputs.

This makes the UI-check surface fully self-documenting — the proof that the machinery from
slices 01–03 carries real, descriptive content end to end before fanning out to other
views.

## Acceptance criteria

- [ ] Guide page authored as markdown: "Investigate a UI-check diff" (walkthrough across viewports → baseline → diff → signals), rendered in the hub under Guides
- [ ] Reference page documenting every `UICheckDetail.svelte` field, table column, and status value (viewports, baseline, diff %, diff threshold, ignore regions, per-signal status, critical_failed vs status, etc.), with anchors
- [ ] `<Hint>` wired onto all remaining fields/columns/section titles on `UICheckDetail.svelte` (the tracer field from 03 plus the rest), each pointing at the right glossary slug / reference anchor
- [ ] Persistent helper text under inputs in the UI-check config form
- [ ] Any new terms surfaced are added to the glossary file (slice 02) — no inline hint references a missing slug
- [ ] Content is end-user phrased and matches the dark Vercel/Geist styling
- [ ] Build/lint/typecheck pass; slice-05 drift test (if landed) stays green

## Blocked by

- `docs/in-app-docs/issues/03-hint-component.md`
