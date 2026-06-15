<script lang="ts">
  import { session } from "./lib/session.svelte.ts";
  import Login from "./Login.svelte";
  import Shell from "./Shell.svelte";

  // Resolve the session cookie once on boot, then render login or the shell.
  $effect(() => {
    session.refresh();
  });
</script>

{#if session.status === "loading"}
  <div class="pageskeleton">Loading…</div>
{:else if session.user}
  <Shell />
{:else}
  <Login />
{/if}
