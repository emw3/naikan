# 04 — web-admin verdict badge

Status: ready-for-agent
Category: enhancement
Type: AFK

## Parent

`docs/regression-judge/PRD.md`

## What to build

Surface the agent's verdict in the product. The run-detail view already receives the
latest verdict in its response (slice 02); render it as a status **badge** next to
the human promote-to-**Baseline** action, with the kind, confidence, model, and
reasoning available. The agent advises; the human promote action is unchanged.

**End-to-end demo:** open a UI **Check run** that has a recorded verdict → a badge
shows the verdict kind (e.g. "Likely noise · 0.91") beside "Promote to baseline",
and the agent's reasoning is readable (inline or on expand). A run with no verdict
shows no badge (no empty state noise).

## Acceptance criteria

- [ ] `AgentVerdict` type + a `verdict: AgentVerdict | null` field added to the SPA's run-detail type (`UIRunDetail`) in the web-admin api client
- [ ] The run-detail view renders the latest verdict as a badge near the promote-to-baseline control: verdict kind (human-readable label), confidence (when present), model, and the reasoning (inline or expandable)
- [ ] Verdict kind maps to reserved status colour + a non-colour cue (icon/label) per the design principles (DESIGN.md / PRODUCT.md): `real_regression` reads as a fail/warning, `noise` / `intentional` read as benign, `uncertain` is neutral — never colour-only (WCAG)
- [ ] No verdict → no badge (no empty placeholder)
- [ ] On-brand with the dark Vercel/Geist look (ADR-0007); reuses existing `app.css` tokens, not a bespoke component
- [ ] `bun run build:web` + `bun run typecheck` pass

## Blocked by

None — depends only on slice 02 (done), which already returns the verdict in run-detail. Can be grabbed in parallel with 03.
