<script lang="ts">
  import { entryForSlug } from "./glossary";

  // The reusable inline-hint affordance (BRIEF.md locked decision #4). A keyboard-
  // focusable `?` button opens a popover showing the glossary `short` plus a "Learn
  // more →" deep-link into the hub. Hints carry NO copy of their own — they read it
  // from the single glossary file by `slug`, so there is one source of truth.
  let { slug }: { slug: string } = $props();

  // Unique popover id per instance so multiple hints (even with the same slug) on a
  // page get distinct `aria-describedby` targets.
  let uid = ++idCounter;
  const popId = `hint-pop-${uid}`;

  const entry = $derived(entryForSlug(slug));
  // Fail loudly in dev so a typo'd / removed slug is caught the moment it renders;
  // the drift-guard test (slice 05) is the CI backstop. In prod, degrade to nothing
  // rather than crash a whole view over one missing hint.
  $effect(() => {
    if (!entry && import.meta.env.DEV) {
      throw new Error(
        `<Hint>: unknown glossary slug "${slug}" — add it to src/docs/glossary.ts or fix the slug.`,
      );
    }
  });

  let open = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let popEl = $state<HTMLDivElement | null>(null);
  // `position: fixed` placement, computed from the trigger rect — fixed escapes any
  // ancestor `overflow` so the popover never clips inside dense, scrollable tables.
  // Hidden until measured so it never flashes at the top-left corner for a frame.
  let posStyle = $state("visibility:hidden");

  function reposition() {
    if (!triggerEl || !popEl) return;
    const r = triggerEl.getBoundingClientRect();
    const pw = popEl.offsetWidth;
    const ph = popEl.offsetHeight;
    const gap = 8;
    const margin = 12;
    // Center under the trigger, then clamp inside the viewport.
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));
    // Prefer below; flip above when it would overflow the bottom and there is room up top.
    let top = r.bottom + gap;
    if (top + ph > window.innerHeight - margin && r.top - gap - ph > margin) {
      top = r.top - gap - ph;
    }
    posStyle = `top:${top}px;left:${left}px;visibility:visible;`;
  }

  // While open, keep the popover glued to the trigger through scrolls/resizes
  // (capture phase catches scrolling of nested table containers, not just window).
  $effect(() => {
    if (!open || !popEl) return;
    reposition();
    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  });

  function close(refocus = false) {
    open = false;
    posStyle = "visibility:hidden"; // next open re-measures before it paints
    if (refocus) triggerEl?.focus();
  }

  function onWindowKeydown(e: KeyboardEvent) {
    if (open && e.key === "Escape") {
      e.stopPropagation();
      close(true);
    }
  }

  // Outside-click / outside-focus dismissal. A pointer or focus landing outside both
  // the trigger and the popover closes it.
  function onWindowPointer(e: MouseEvent) {
    if (!open) return;
    const t = e.target as Node;
    if (triggerEl?.contains(t) || popEl?.contains(t)) return;
    close();
  }
</script>

{#if entry}
  <span class="hint">
    <button
      bind:this={triggerEl}
      type="button"
      class="hint-trigger"
      aria-label={`What is “${entry.term}”?`}
      aria-expanded={open}
      aria-describedby={open ? popId : undefined}
      onclick={() => (open ? close() : (open = true))}
    >
      ?
    </button>

    {#if open}
      <div
        bind:this={popEl}
        id={popId}
        class="hint-pop"
        role="dialog"
        aria-label={entry.term}
        style={posStyle}
      >
        <p class="hint-term">{entry.term}</p>
        <p class="hint-short">{entry.short}</p>
        <a
          class="hint-more"
          href={`#/docs/concepts/${entry.slug}`}
          onclick={() => close()}
        >
          Learn more →
        </a>
      </div>
    {/if}
  </span>
{/if}

<svelte:window onkeydown={onWindowKeydown} onpointerdown={onWindowPointer} />

<script lang="ts" module>
  // Monotonic per-page counter for unique popover ids.
  let idCounter = 0;
</script>

<style>
  .hint {
    position: relative;
    display: inline-flex;
    vertical-align: middle;
  }

  .hint-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.125rem;
    height: 1.125rem;
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--r-full);
    background: var(--panel-2);
    color: var(--ink-muted);
    font-size: var(--t-caption);
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    transition:
      color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }
  .hint-trigger:hover,
  .hint-trigger[aria-expanded="true"] {
    color: var(--ink);
    border-color: var(--steel-weak-border);
    background: var(--steel-weak);
  }

  .hint-pop {
    position: fixed;
    z-index: var(--z-drawer);
    width: max-content;
    max-width: min(20rem, calc(100vw - 24px));
    padding: var(--s3) var(--s4);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--panel);
    box-shadow: var(--shadow-pop);
    text-align: left;
  }

  .hint-term {
    font-size: var(--t-label);
    font-weight: 600;
    color: var(--ink);
  }
  .hint-short {
    margin-top: var(--s1);
    font-size: var(--t-data);
    line-height: 1.45;
    color: var(--ink-muted);
  }
  .hint-more {
    display: inline-block;
    margin-top: var(--s2);
    font-size: var(--t-label);
    font-weight: 500;
    color: var(--steel-ink);
  }
  .hint-more:hover {
    text-decoration: underline;
  }

  /* Motion is decorative only — instant for users who ask for reduced motion. */
  @media (prefers-reduced-motion: no-preference) {
    .hint-pop {
      animation: hint-in var(--dur-fast) var(--ease-out);
    }
    @keyframes hint-in {
      from {
        opacity: 0;
        transform: translateY(-4px);
      }
    }
  }
</style>
