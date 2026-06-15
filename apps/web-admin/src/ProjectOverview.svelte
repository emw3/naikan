<script lang="ts">
  import * as api from "./lib/api.ts";
  import type { ProjectOverview, OverviewCheck, CheckState } from "./lib/api.ts";
  import { session } from "./lib/session.svelte.ts";

  let { projectId }: { projectId: string } = $props();

  let data = $state<ProjectOverview | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  async function load() {
    loading = true;
    loadError = null;
    try {
      data = await api.getProjectOverview(projectId);
    } catch (err) {
      loadError = err instanceof api.ApiError ? err.message : "Could not load project overview";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void projectId;
    load();
  });

  /** Deep-link a check row to its detail page (heartbeat vs UI live at different routes). */
  function detailHref(c: OverviewCheck): string {
    return c.kind === "uicheck" ? `#/uichecks/${c.id}` : `#/checks/${c.id}`;
  }

  function tally(c: OverviewCheck): string {
    const { pass, fail, total } = c.last24h;
    if (total === 0) return "no runs in 24h";
    return fail === 0 ? `${pass}/${total} passed` : `${pass}/${total} passed · ${fail} failed`;
  }

  /** Map a check's state to a status dot class + word (dot+word keeps WCAG "never color alone"). */
  function checkStatus(state: CheckState): { cls: string; label: string } {
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

  /** Aggregate the checks into the summary tiles (status, counts, 24h uptime). */
  let agg = $derived.by(() => {
    const checks = data?.checks ?? [];
    let pass = 0;
    let total = 0;
    let okCount = 0;
    let failing = 0;
    for (const c of checks) {
      pass += c.last24h.pass;
      total += c.last24h.total;
      if (c.state === "ok") okCount += 1;
      else if (c.state === "failing" || c.state === "incident") failing += 1;
    }
    const incidents = data?.openIncidentCount ?? 0;
    const overall: { cls: string; label: string } =
      incidents > 0
        ? { cls: "fail", label: "Down" }
        : failing > 0
          ? { cls: "fail", label: "Failing" }
          : checks.length === 0
            ? { cls: "idle", label: "No checks" }
            : okCount === checks.length
              ? { cls: "ok", label: "Operational" }
              : { cls: "idle", label: "No data" };
    return {
      overall,
      incidents,
      count: checks.length,
      okCount,
      failing,
      uptime: total > 0 ? ((pass / total) * 100).toFixed(1) : null,
    };
  });
</script>

<a class="back" href="#/projects">← Projects</a>

{#if loading}
  <p class="empty">Loading…</p>
{:else if loadError || !data}
  <p class="formerror" role="alert">{loadError ?? "Project not found"}</p>
{:else}
  <div class="pagehead">
    <div>
      <h1>{data.project.name}</h1>
      <p class="lede">{data.project.contacts || "No contacts on file"}</p>
    </div>
    <div class="spacer"></div>
    {#if session.isAdmin}
      <a class="btn btn-secondary" href={`#/projects/${projectId}/config`}>Manage</a>
    {/if}
  </div>

  <div class="tiles">
    <div class="tile">
      <div class="k">Status</div>
      <div class="v">
        <span class="status {agg.overall.cls}"><span class="dot"></span>{agg.overall.label}</span>
      </div>
    </div>
    <div class="tile">
      <div class="k">Open incidents</div>
      <div class="v" class:bad={agg.incidents > 0}>{agg.incidents}</div>
    </div>
    <div class="tile">
      <div class="k">Checks</div>
      <div class="v">
        {agg.count}
        {#if agg.count}
          <small>{agg.okCount} ok{#if agg.failing} · {agg.failing} failing{/if}</small>
        {/if}
      </div>
    </div>
    <div class="tile">
      <div class="k">Uptime (24h)</div>
      <div class="v">{#if agg.uptime}{agg.uptime}<small>%</small>{:else}—{/if}</div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <h2>Checks</h2>
      <span class="n">{data.checks.length}</span>
    </div>

    {#if data.checks.length === 0}
      <p class="empty">No checks configured for this project yet.</p>
    {:else}
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>Check</th>
              <th>Kind</th>
              <th class="num">Last 24h</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each data.checks as c (c.id)}
              {@const st = checkStatus(c.state)}
              <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
              <tr class="link" onclick={() => (location.hash = detailHref(c))}>
                <td><a class="t-primary mono" href={detailHref(c)}>{c.host}{c.path}</a></td>
                <td><span class="tag">{c.kind === "uicheck" ? "UI" : "heartbeat"}</span></td>
                <td class="num muted">{tally(c)}</td>
                <td>
                  <span class="status {st.cls}"><span class="dot"></span>{st.label}</span>
                </td>
                <td class="shrink">
                  <svg
                    class="chev"
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    aria-hidden="true"
                  >
                    <path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
{/if}
