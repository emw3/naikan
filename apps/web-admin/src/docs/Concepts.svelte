<script lang="ts">
  import { GLOSSARY, entryForSlug } from "./glossary";

  // `term` is the deep-link slug from `#/docs/concepts/:slug` (null at `#/docs/concepts`).
  // On mount and whenever it changes, scroll the matching term into view. This is the
  // hash-routing anchor contract: a plain `#anchor` fragment can't be used because the
  // fragment IS the router's input, so the target is carried in the route (BRIEF.md).
  let { term = null }: { term?: string | null } = $props();

  let highlighted = $state<string | null>(null);

  $effect(() => {
    const entry = entryForSlug(term);
    if (!entry) {
      highlighted = null;
      return; // unknown/absent slug → stay at the top of the page, no crash
    }
    const el = document.getElementById(entry.anchor);
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    highlighted = entry.slug;
  });
</script>

<div class="prose glossary">
  <p>
    The core ideas behind Naikan Monitor’s UI checks, in plain terms. The inline “?”
    hints across the app link straight to the term they explain.
  </p>
  {#each GLOSSARY as entry (entry.slug)}
    <section
      id={entry.anchor}
      class="glossary-term"
      class:highlighted={entry.slug === highlighted}
    >
      <h2>{entry.term}</h2>
      <p>{entry.body}</p>
    </section>
  {/each}
</div>
