// The single structured glossary. ONE source of truth for term definitions,
// consumed by BOTH the hub Concepts page (renders `body`) AND the inline `?` hints
// (slice 03 reads `short`). No DB, no CMS (BRIEF.md, locked decision #3).
//
// `slug` is the route segment a hint deep-links to (`#/docs/concepts/<slug>`); the
// Concepts page renders an element with id=`anchor` per entry and scrolls it into view.
// Phrasing is deliberately end-user facing — NOT CONTEXT.md's domain-expert wording.
export interface GlossaryEntry {
  slug: string;
  term: string;
  short: string; // one-line summary for the inline `?` hint popover (slice 03)
  body: string; // longer end-user explanation rendered on the Concepts page
  aliases?: string[]; // alternate slugs a hint may deep-link with
  anchor: string; // DOM id the Concepts page assigns; the scroll target
}

export const GLOSSARY: GlossaryEntry[] = [
  {
    slug: "ui-check",
    term: "UI check",
    aliases: ["uicheck", "ui-checks"],
    anchor: "concept-ui-check",
    short:
      "A daily visual check that loads a page in a real browser and flags visual or loading problems.",
    body: "Once a day, Naikan Monitor opens one of your pages in a real browser at three screen sizes, takes screenshots, compares them against an approved version, and reports anything that looks broken. Unlike a Heartbeat check — which just confirms the site responds every few minutes — a UI check looks at what visitors actually see.",
  },
  {
    slug: "viewport",
    term: "Viewport",
    aliases: ["viewports", "breakpoint"],
    anchor: "concept-viewport",
    short: "One of three screen sizes — mobile, tablet, or desktop — a UI check looks at.",
    body: "Every UI check runs at three fixed screen widths: mobile, tablet, and desktop. Each size is checked on its own, so a layout that breaks only on phones shows up as a problem on the mobile viewport while tablet and desktop stay green.",
  },
  {
    slug: "baseline",
    term: "Baseline",
    anchor: "concept-baseline",
    short: "The approved screenshot a new run is compared against.",
    body: "A baseline is the “this is what the page should look like” screenshot for one viewport. New runs are compared against it. When a change is intentional, someone promotes the latest screenshot to become the new baseline so it stops being flagged. Each viewport keeps its own baseline.",
  },
  {
    slug: "diff",
    term: "Diff",
    aliases: ["visual-diff"],
    anchor: "concept-diff",
    short: "How much a page’s screenshot changed from its baseline, as a percentage.",
    body: "A diff measures how much the page’s new screenshot differs from its baseline — shown as a percentage plus a highlighted overlay of exactly what changed. Regions you’ve told Monitor to ignore are skipped. When the difference is larger than the allowed threshold, that viewport is flagged as a visual change.",
  },
  {
    slug: "signal",
    term: "Signal",
    aliases: ["signals"],
    anchor: "concept-signal",
    short: "One thing a UI check judges — page load, console errors, key elements, or performance.",
    body: "Each UI check run reports four signals: whether the page loaded, whether the browser console threw errors, whether expected elements are present, and how the page performed. Each signal is rated critical or warning. A critical failure can open an incident and page the team; a warning only rolls into the daily digest.",
  },
  {
    slug: "check-run",
    term: "Check run",
    aliases: ["run", "runs"],
    anchor: "concept-check-run",
    short: "A single execution of a check, with its results and screenshots.",
    body: "A check run is one execution of a check at a point in time. For a UI check it holds the screenshots and diff overlays for each viewport plus the combined signal results — so you can open any past run and see exactly what the page looked like and what passed or failed.",
  },
  {
    slug: "capture",
    term: "Capture",
    anchor: "concept-capture",
    short: "Loading a page in a real browser and recording what happened — with no pass/fail.",
    body: "Capture is the raw data-gathering step: Monitor loads your page in a real browser at one viewport and records the screenshot, console messages, timing, and which elements were found. Capture itself makes no pass/fail judgment — that happens afterward, when the run is turned into signals and diffs.",
  },
];

// Resolve a deep-link slug (from a hint or the `#/docs/concepts/:slug` route) to its
// entry, matching the canonical slug first, then aliases. Case-insensitive. Returns
// undefined for an unknown slug so callers degrade gracefully (no crash).
export function entryForSlug(slug: string | null | undefined): GlossaryEntry | undefined {
  if (!slug) return undefined;
  const key = slug.toLowerCase();
  return GLOSSARY.find(
    (e) => e.slug === key || e.aliases?.some((a) => a.toLowerCase() === key),
  );
}
