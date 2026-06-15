<script lang="ts">
  import * as api from "./lib/api.ts";
  import type { HeartbeatDetail, CheckState } from "./lib/api.ts";
  import { fmtDuration, fmtWhen } from "./lib/format.ts";

  let { checkId }: { checkId: string } = $props();

  let data = $state<HeartbeatDetail | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  async function load() {
    loading = true;
    loadError = null;
    try {
      data = await api.getHeartbeatDetail(checkId);
    } catch (err) {
      loadError = err instanceof api.ApiError ? err.message : "Could not load check detail";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void checkId;
    load();
  });

  /** Timeline is oldest-first; the row list reads best newest-first. */
  let rows = $derived(data ? [...data.timeline].reverse() : []);

  function incidentSpan(i: api.Incident): string {
    const end = i.closedAt ? new Date(i.closedAt).getTime() : new Date(i.openedAt).getTime();
    return fmtDuration(Math.max(0, end - new Date(i.openedAt).getTime()));
  }

  /** Map a check's state to a status dot class + word. */
  function stateStatus(state: CheckState): { cls: string; label: string } {
    switch (state) {
      case "ok":
        return { cls: "ok", label: "Healthy" };
      case "failing":
        return { cls: "fail", label: "Failing" };
      case "incident":
        return { cls: "fail", label: "Incident" };
      default:
        return { cls: "idle", label: "No data" };
    }
  }
</script>

{#if loading}
  <p class="empty">Loading…</p>
{:else if loadError || !data}
  <p class="formerror" role="alert">{loadError ?? "Check not found"}</p>
{:else}
  {@const st = stateStatus(data.state)}
  <a class="back" href={`#/projects/${data.projectId}`}>← Overview</a>

  <div class="pagehead">
    <div>
      <h1 class="mono">{data.host}{data.check.path}</h1>
      <p class="cv-meta">
        <span class="tag">heartbeat</span>
        <span class="sub">
          {#if data.last24h.total === 0}
            no runs in the last 24h
          {:else}
            {data.last24h.pass}/{data.last24h.total} passed in 24h
          {/if}
        </span>
      </p>
    </div>
    <div class="spacer"></div>
    <span class="status {st.cls}"><span class="dot"></span>{st.label}</span>
  </div>

  <div class="panel">
    <div class="panel-head">
      <h2>Last 24 hours</h2>
      <span class="n">{data.last24h.total}</span>
    </div>

    {#if data.timeline.length === 0}
      <p class="empty">No runs recorded in the last 24 hours.</p>
    {:else}
      <!-- Compact stripe: one segment per run, oldest → newest, left to right. -->
      <div class="stripe-wrap">
        <div class="stripe" aria-hidden="true">
          {#each data.timeline as run (run.id)}
            <span
              class="seg"
              class:fail={run.status === "fail"}
              title={`${run.status} · ${fmtWhen(run.startedAt)}`}
            ></span>
          {/each}
        </div>
      </div>

      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>Time</th>
              <th class="num">Latency</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as run (run.id)}
              <tr>
                <td>
                  <span class="t-primary">{fmtWhen(run.startedAt)}</span>
                  {#if run.error}<div class="t-sub runfail mono">{run.error}</div>{/if}
                </td>
                <td class="num mono">{run.latencyMs} ms</td>
                <td>
                  <span class="status {run.status === 'pass' ? 'ok' : 'fail'}">
                    <span class="dot"></span>{run.status === "pass" ? "Pass" : "Fail"}
                  </span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>

  <div class="panel section-gap">
    <div class="panel-head">
      <h2 class:incident-open={data.recentIncidents.some((i) => i.closedAt === null)}>
        Recent incidents
      </h2>
      <span class="n">{data.recentIncidents.length}</span>
    </div>

    {#if data.recentIncidents.length === 0}
      <p class="empty">No incidents on record for this check.</p>
    {:else}
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>Opened</th>
              <th>Recovered</th>
              <th class="num">Duration</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {#each data.recentIncidents as inc (inc.id)}
              <tr>
                <td class="muted">{fmtWhen(inc.openedAt)}</td>
                <td class="muted">{inc.closedAt ? fmtWhen(inc.closedAt) : "—"}</td>
                <td class="num mono">{incidentSpan(inc)}</td>
                <td>
                  <span class="status {inc.closedAt ? 'ok' : 'fail'}">
                    <span class="dot"></span>{inc.closedAt ? "Recovered" : "Open"}
                  </span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
{/if}

<style>
  .stripe-wrap {
    padding: var(--s4) var(--s4) 0;
  }
  .stripe {
    display: flex;
    gap: 2px;
    flex-wrap: wrap;
  }
  .seg {
    width: 10px;
    height: 22px;
    border-radius: 2px;
    background: color-mix(in oklch, var(--ok) 60%, var(--bg));
  }
  .seg.fail {
    background: var(--fail-solid);
  }
  .section-gap {
    margin-top: var(--s6);
  }
  .incident-open {
    color: var(--fail-ink);
  }
</style>
