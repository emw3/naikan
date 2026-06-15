<script lang="ts">
  import * as api from "./lib/api.ts";
  import type { IncidentRow } from "./lib/api.ts";
  import { fmtDuration, fmtWhen } from "./lib/format.ts";

  let status = $state<"open" | "closed">("open");
  let incidents = $state<IncidentRow[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  async function load() {
    loading = true;
    loadError = null;
    try {
      incidents = await api.listIncidents(status);
    } catch (err) {
      loadError = err instanceof api.ApiError ? err.message : "Could not load incidents";
    } finally {
      loading = false;
    }
  }

  // Re-load whenever the open/closed filter changes.
  $effect(() => {
    void status;
    load();
  });

  /** Deep-link a row to its check's detail page. */
  function detailHref(i: IncidentRow): string | null {
    if (i.checkType === "uicheck") return `#/uichecks/${i.checkId}`;
    if (i.checkType === "heartbeat") return `#/checks/${i.checkId}`;
    return null;
  }
</script>

<div class="pagehead">
  <div>
    <h1>Incidents</h1>
    <p class="lede">Across the projects you can see.</p>
  </div>
  <div class="spacer"></div>
  <div class="toggle" role="tablist" aria-label="Incident status">
    <button class="toggle-btn" class:active={status === "open"} role="tab" aria-selected={status === "open"} onclick={() => (status = "open")}>
      Open
    </button>
    <button class="toggle-btn" class:active={status === "closed"} role="tab" aria-selected={status === "closed"} onclick={() => (status = "closed")}>
      Resolved
    </button>
  </div>
</div>

{#if loading}
  <p class="empty">Loading…</p>
{:else if loadError}
  <p class="formerror" role="alert">{loadError}</p>
{:else if incidents.length === 0}
  <p class="empty">
    {status === "open" ? "No open incidents. All clear." : "No resolved incidents on record."}
  </p>
{:else}
  <div class="panel">
    <div class="panel-head">
      <h2>{status === "open" ? "Open incidents" : "Resolved incidents"}</h2>
      <span class="n">{incidents.length}</span>
    </div>
    <div class="tbl-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th>Check</th>
            <th>Project</th>
            <th>Opened</th>
            {#if status === "closed"}<th>Recovered</th>{/if}
            <th class="num">Duration</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {#each incidents as inc (inc.id)}
            {@const href = detailHref(inc)}
            <tr>
              <td>
                {#if href}
                  <a class="t-primary mono" {href}>{inc.checkLabel}</a>
                {:else}
                  <span class="t-primary mono">{inc.checkLabel}</span>
                {/if}
              </td>
              <td><a class="cl" href={`#/projects/${inc.projectId}`}>{inc.projectName}</a></td>
              <td class="muted">{fmtWhen(inc.openedAt)}</td>
              {#if status === "closed"}
                <td class="muted">{inc.closedAt ? fmtWhen(inc.closedAt) : "—"}</td>
              {/if}
              <td class="num mono">{fmtDuration(inc.durationMs)}{inc.open ? " so far" : ""}</td>
              <td>
                <span class="status {inc.open ? 'fail' : 'ok'}">
                  <span class="dot"></span>{inc.open ? "Open" : "Recovered"}
                </span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
{/if}

<style>
  .toggle {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    background: var(--hover);
    border-radius: var(--r-full);
  }
  .toggle-btn {
    border: none;
    background: none;
    padding: 4px 14px;
    border-radius: var(--r-full);
    font-size: var(--t-label);
    color: var(--ink-muted);
    cursor: pointer;
  }
  .toggle-btn.active {
    background: var(--panel-2);
    color: var(--ink);
    font-weight: 600;
  }
  .cl {
    color: inherit;
    text-decoration: underline;
  }
</style>
