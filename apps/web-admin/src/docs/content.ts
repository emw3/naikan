import gettingStarted from "./content/getting-started.md?raw";

// The docs hub IA (Diátaxis): a short Getting Started plus the Concepts / Guides /
// Reference triad. `slug` is the route segment (`#/docs/<slug>`); the first section is
// the default rendered at `#/docs`. `markdown: null` marks a section that's scaffolded
// in the nav but not yet authored — later slices fill these in (BRIEF.md).
export interface DocSection {
  slug: string;
  label: string;
  markdown: string | null;
}

export const SECTIONS: DocSection[] = [
  { slug: "getting-started", label: "Getting Started", markdown: gettingStarted },
  { slug: "concepts", label: "Concepts", markdown: null },
  { slug: "guides", label: "Guides", markdown: null },
  { slug: "reference", label: "Reference", markdown: null },
];

export const DEFAULT_SECTION = SECTIONS[0];

export function sectionForSlug(slug: string | null): DocSection {
  return SECTIONS.find((s) => s.slug === slug) ?? DEFAULT_SECTION;
}
