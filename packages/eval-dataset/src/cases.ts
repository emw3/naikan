/**
 * The synthetic seed-case catalog (issue #05) — shared by the corpus generator
 * (`generate.ts`) and the live-stack demo seed (`seed-demo.ts`) so both stay in
 * lockstep: the same deterministic pages, captured through the same real pipeline,
 * feed the labeled corpus AND the demo Project an agent judges live.
 *
 * Each case names a seed page under `seed-pages/` and two query variants — the
 * baseline state and the current state. For a `noise` case the two variants are
 * identical: the page varies itself on each load (a clock tick, a rotating
 * banner), so two sequential captures differ without any code change — exactly the
 * "diffs but isn't a regression" class. For `real_regression` / `intentional` the
 * current variant deliberately changes the page.
 *
 * The label is therefore known **by construction** — the generator records it; no
 * human labels the synthetic set (the human-in-the-loop step is the curated set).
 */
import type { Label } from "./types.ts";

export type SeedViewport = "mobile" | "tablet" | "desktop";

export interface SeedCase {
  /** Stable id; also the fixture subdirectory + the demo UI check's path slug. */
  id: string;
  /** Ground-truth label, known because the generator controls the change. */
  label: Label;
  /** Seed page filename under `seed-pages/`, without the `.html`. */
  page: string;
  /** Query string for the baseline capture (e.g. `?v=baseline`). */
  baselineQuery: string;
  /** Query string for the current capture. Equal to `baselineQuery` for noise. */
  currentQuery: string;
  /** Viewport the case is designed to manifest at. */
  viewport: SeedViewport;
  /** One-line human description of what changed (→ fixture notes + demo blurb). */
  notes: string;
}

/**
 * Seeded across the three constructable labels for balance: 2 real_regression,
 * 2 noise, 2 intentional. `uncertain` is never a ground truth (see types.ts).
 */
export const SEED_CASES: SeedCase[] = [
  {
    id: "layout-break",
    label: "real_regression",
    page: "layout-break",
    baselineQuery: "?v=baseline",
    currentQuery: "?v=broken",
    viewport: "desktop",
    notes: "Pricing card pulled out of flow (position:absolute) and overlapping its neighbours.",
  },
  {
    id: "overflow-break",
    label: "real_regression",
    page: "overflow-break",
    baselineQuery: "?v=baseline",
    currentQuery: "?v=broken",
    viewport: "desktop",
    notes: "Product image sized to 160% overflows its tile and shoves the grid out of alignment.",
  },
  {
    id: "live-clock",
    label: "noise",
    page: "live-clock",
    baselineQuery: "",
    currentQuery: "",
    viewport: "desktop",
    notes: "Status page timestamp + request id tick between captures; structure unchanged.",
  },
  {
    id: "rotating-hero",
    label: "noise",
    page: "rotating-hero",
    baselineQuery: "",
    currentQuery: "",
    viewport: "desktop",
    notes: "Marketing hero rotates its background hue + testimonial each load, like a carousel.",
  },
  {
    id: "brand-restyle",
    label: "intentional",
    page: "brand-restyle",
    baselineQuery: "?v=baseline",
    currentQuery: "?v=restyled",
    viewport: "desktop",
    notes: "Deliberate rebrand: indigo→teal, squared→pill buttons, flat→shadowed cards. Layout intact.",
  },
  {
    id: "type-restyle",
    label: "intentional",
    page: "type-restyle",
    baselineQuery: "?v=baseline",
    currentQuery: "?v=restyled",
    viewport: "desktop",
    notes: "Typography refresh: serif→sans body, looser leading, accent-coloured headings. Intentional.",
  },
];
