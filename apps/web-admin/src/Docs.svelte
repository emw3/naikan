<script lang="ts">
  import { SECTIONS, DEFAULT_SECTION, sectionForSlug } from "./docs/content";
  import { renderMarkdown } from "./docs/render";
  import Concepts from "./docs/Concepts.svelte";

  // `section` is the route segment after `#/docs/` (null at `#/docs`). The default
  // section renders at the bare `#/docs` route. `term` is the deeper segment
  // (`#/docs/concepts/:term`) — the glossary slug the Concepts page scrolls into view.
  let { section = null, term = null }: { section?: string | null; term?: string | null } =
    $props();

  let active = $derived(sectionForSlug(section));
  // Concepts is rendered from structured glossary data (not markdown); every other
  // section renders authored markdown when present.
  let html = $derived(active.markdown ? renderMarkdown(active.markdown) : null);

  function go(slug: string) {
    location.hash = slug === DEFAULT_SECTION.slug ? "#/docs" : `#/docs/${slug}`;
  }
</script>

<div class="pagehead">
  <div>
    <h1>Documentation</h1>
    <p class="lede">
      How every field, form, check, and status in Naikan Monitor works — the team's
      single source of truth.
    </p>
  </div>
</div>

<nav class="docs-nav" aria-label="Documentation sections">
  {#each SECTIONS as s (s.slug)}
    <button class="docs-tab" class:active={s.slug === active.slug} onclick={() => go(s.slug)}>
      {s.label}
    </button>
  {/each}
</nav>

{#if active.slug === "concepts"}
  <Concepts {term} />
{:else if html}
  <!-- Trusted, PR-reviewed in-repo markdown — see docs/render.ts -->
  <article class="prose">{@html html}</article>
{:else}
  <div class="docs-empty">
    <p><strong>{active.label}</strong> is coming soon.</p>
    <p class="muted">
      This section is scaffolded but not yet written. Content lands here in an upcoming
      slice.
    </p>
  </div>
{/if}
