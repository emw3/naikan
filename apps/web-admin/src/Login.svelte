<script lang="ts">
  import { session } from "./lib/session.svelte.ts";
  import { ApiError } from "./lib/api.ts";

  let email = $state("");
  let password = $state("");
  let error = $state<string | null>(null);
  let submitting = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = null;
    submitting = true;
    try {
      await session.login(email.trim(), password);
      // On success the app shell renders reactively (session.user is set).
    } catch (err) {
      error = err instanceof ApiError ? err.message : "Sign in failed — try again";
    } finally {
      submitting = false;
    }
  }
</script>

<div class="login">
  <div class="login-inner">
    <div class="brand">
      <svg class="logo" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3" y="4" width="18" height="14" rx="3" stroke="currentColor" stroke-width="2" />
        <path
          d="M6 12h2.5l1.5-3 2 6 1.5-3H18"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span>Naikan Monitor</span>
    </div>

    <div>
      <h1>Sign in</h1>
      <p class="sub">Use your Naikan email and password.</p>
    </div>

    <form onsubmit={submit}>
      <div class="field">
        <label for="email">Email</label>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          id="email"
          class="input"
          type="email"
          autocomplete="username"
          bind:value={email}
          required
          autofocus
        />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input
          id="password"
          class="input"
          type="password"
          autocomplete="current-password"
          bind:value={password}
          required
        />
      </div>

      {#if error}
        <p class="formerror" role="alert">{error}</p>
      {/if}

      <button class="btn btn-primary" type="submit" disabled={submitting}>
        {submitting ? "Signing in…" : "Sign in"}
      </button>
    </form>
  </div>
</div>
