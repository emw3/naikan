<script lang="ts">
  import * as api from "./lib/api.ts";
  import type { CheckRun, CheckState, Incident, UICheck } from "./lib/api.ts";
  import { session } from "./lib/session.svelte.ts";
  import { fmtDuration, fmtWhen } from "./lib/format.ts";
  import Hint from "./docs/Hint.svelte";

  let { checkId }: { checkId: string } = $props();

  let check = $state<UICheck | null>(null);
  // Read-only detail meta (#16): current state badge + recent incidents.
  let state_ = $state<CheckState>("unknown");
  let recentIncidents = $state<Incident[]>([]);
  let runs = $state<CheckRun[]>([]);
  let selectedRunId = $state<string | null>(null);
  let screenshots = $state<Record<string, string>>({});
  let diffs = $state<Record<string, api.UIRunDiff>>({});
  let baseline = $state<Record<string, string>>({});
  let signals = $state<Record<string, api.UISignal[]>>({});
  // The agent's latest regression-judge verdict for the selected run, or null (#04).
  let verdict = $state<api.AgentVerdict | null>(null);
  // True once the retention reaper has deleted this run's artifacts (#17).
  let expired = $state(false);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let runLoading = $state(false);
  let runError = $state<string | null>(null);
  let queued = $state(false);
  let promoting = $state(false);
  let promoteMsg = $state<string | null>(null);

  async function load() {
    loading = true;
    loadError = null;
    try {
      // One call yields the check config + current state + recent incidents (#16).
      const meta = await api.getUICheckMeta(checkId);
      check = meta.check;
      state_ = meta.state;
      recentIncidents = meta.recentIncidents;
      runs = await api.listUIRuns(checkId);
      if (runs.length > 0) {
        await selectRun(runs[0]!.id);
      } else {
        selectedRunId = null;
        screenshots = {};
      }
    } catch (err) {
      loadError = err instanceof api.ApiError ? err.message : "Could not load UI check";
    } finally {
      loading = false;
    }
  }

  async function selectRun(runId: string) {
    runLoading = true;
    runError = null;
    selectedRunId = runId;
    try {
      const detail = await api.getUIRun(checkId, runId);
      screenshots = detail.screenshots;
      diffs = detail.diffs ?? {};
      baseline = detail.baseline ?? {};
      signals = detail.signals ?? {};
      verdict = detail.verdict ?? null;
      expired = detail.expired ?? false;
    } catch (err) {
      screenshots = {};
      diffs = {};
      baseline = {};
      signals = {};
      verdict = null;
      expired = false;
      runError = err instanceof api.ApiError ? err.message : "Could not load run artifacts";
    } finally {
      runLoading = false;
    }
  }

  async function promote() {
    if (!selectedRunId) return;
    promoting = true;
    promoteMsg = null;
    const runId = selectedRunId;
    try {
      check = await api.promoteUIRun(checkId, runId);
      await selectRun(runId); // refresh the baseline panel from the new approved baseline
      promoteMsg = "Promoted to baseline. Future runs diff against this capture.";
    } catch (err) {
      promoteMsg = err instanceof api.ApiError ? err.message : "Could not promote to baseline";
    } finally {
      promoting = false;
    }
  }

  async function runNow() {
    queued = false;
    runError = null;
    try {
      await api.runUICheck(checkId);
      queued = true;
    } catch (err) {
      runError = err instanceof api.ApiError ? err.message : "Could not queue run";
    }
  }

  $effect(() => {
    void checkId;
    load();
  });

  function fmt(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  // Show screenshots in the check's configured viewport order, falling back to
  // whatever the run's manifest actually produced.
  let orderedViewports = $derived(
    check
      ? check.viewports.filter((v) => v in screenshots).concat(
          Object.keys(screenshots).filter((v) => !check!.viewports.includes(v)),
        )
      : Object.keys(screenshots),
  );

  // Once a baseline is promoted, the run view becomes a baseline | current | diff
  // comparison; before that it is just the captured screenshots.
  let hasBaseline = $derived(Object.keys(baseline).length > 0);

  function regressed(pct: number): boolean {
    return check ? pct > check.diffThreshold : false;
  }

  // Signals in the check's viewport order, falling back to whatever the run's
  // manifest recorded (mirrors `orderedViewports` for screenshots).
  let signalViewports = $derived(
    check
      ? check.viewports.filter((v) => v in signals).concat(
          Object.keys(signals).filter((v) => !check!.viewports.includes(v)),
        )
      : Object.keys(signals),
  );

  const SIGNAL_LABELS: Record<string, string> = {
    load: "Load",
    console: "Console",
    selector: "Selector",
    perf: "Perf",
  };

  // Last 14 runs as a stripe, oldest → newest (runs arrive newest-first).
  let stripe = $derived([...runs].slice(0, 14).reverse());

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
  let badge = $derived(stateStatus(state_));

  /**
   * Map an agent verdict kind to a status dot class + human-readable label (#04).
   * Colour reuses the reserved status tokens, always paired with the word (the
   * non-colour cue, WCAG): a real regression reads as a fail; noise and an
   * intentional change read as benign; uncertain is neutral. The agent advises —
   * the human promote-to-baseline action is unchanged.
   */
  function verdictStatus(kind: api.VerdictKind): { cls: string; label: string } {
    switch (kind) {
      case "real_regression":
        return { cls: "fail", label: "Likely regression" };
      case "noise":
        return { cls: "ok", label: "Likely noise" };
      case "intentional":
        return { cls: "ok", label: "Intentional change" };
      default:
        return { cls: "idle", label: "Uncertain" };
    }
  }
  let verdictBadge = $derived(verdict ? verdictStatus(verdict.verdict) : null);

  function incidentSpan(i: Incident): string {
    const end = i.closedAt ? new Date(i.closedAt).getTime() : Date.now();
    return fmtDuration(end - new Date(i.openedAt).getTime());
  }
</script>

{#if loading}
  <p class="empty">Loading…</p>
{:else if loadError || !check}
  <p class="formerror" role="alert">{loadError ?? "UI check not found"}</p>
{:else}
  <a class="back" href={`#/sites/${check.siteId}`}>← Site</a>

  <div class="pagehead">
    <div>
      <h1 class="mono">{check.path}</h1>
      <p class="cv-meta">
        {#each check.viewports as v}<span class="tag">{v}</span>{/each}
        <span class="sub">diff &gt; {check.diffThreshold}</span>
      </p>
    </div>
    <div class="spacer"></div>
    <span class="status {badge.cls}"><span class="dot"></span>{badge.label}</span>
    {#if session.isAdmin}
      <button class="btn btn-secondary" onclick={runNow}>Run now</button>
    {/if}
  </div>

  {#if queued}
    <p class="runline">Run queued — refresh in a moment to see the new capture.</p>
  {/if}
  {#if runError}
    <p class="formerror runline" role="alert">{runError}</p>
  {/if}

  <section class="section">
    <div class="section-head">
      <h2>Runs</h2>
      <span class="n">{runs.length}</span>
    </div>
    {#if stripe.length > 0}
      <!-- Last 14 runs, oldest → newest (#16). -->
      <div class="stripe" aria-hidden="true">
        {#each stripe as run (run.id)}
          <span class="seg" class:fail={run.status === "fail"} title={`${run.status} · ${fmtWhen(run.startedAt)}`}></span>
        {/each}
      </div>
    {/if}
    {#if runs.length === 0}
      <p class="empty">No runs yet. Use “Run now” to capture this page.</p>
    {:else}
      <div class="panel">
        <div class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>Run</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {#each runs as run (run.id)}
                <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                <tr
                  class="link"
                  class:selected={run.id === selectedRunId}
                  onclick={() => selectRun(run.id)}
                >
                  <td><span class="t-primary">{fmt(run.startedAt)}</span></td>
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
      </div>
    {/if}
  </section>

  <section class="section">
    <div class="section-head" class:incident-open={recentIncidents.some((i) => i.closedAt === null)}>
      <h2>Recent incidents</h2>
      <span class="n">{recentIncidents.length}</span>
    </div>
    {#if recentIncidents.length === 0}
      <p class="empty">No incidents on record for this check.</p>
    {:else}
      <div class="panel">
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
              {#each recentIncidents as inc (inc.id)}
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
      </div>
    {/if}
  </section>

  {#if selectedRunId}
    <section class="section">
      <div class="section-head">
        <h2>Signals <Hint slug="signal" /></h2>
      </div>
      {#if runLoading}
        <p class="empty">Loading signals…</p>
      {:else if signalViewports.length === 0}
        <p class="empty">This run recorded no signals.</p>
      {:else}
        <div class="sig-list">
          {#each signalViewports as vp (vp)}
            <div class="sig-vp">
              <div class="sig-vp-head"><span class="vp">{vp}</span></div>
              <ul class="sig-rows">
                {#each signals[vp] ?? [] as s (s.kind)}
                  <li class="sig-row">
                    <span class="pill" class:pill-ok={s.pass} class:pill-fail={!s.pass}>
                      {s.pass ? "Pass" : "Fail"}
                    </span>
                    <span class="sig-kind">{SIGNAL_LABELS[s.kind] ?? s.kind}</span>
                    <span class="tag">{s.severity}</span>
                    <span class="sub sig-detail">{s.detail}</span>
                  </li>
                {/each}
              </ul>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <section class="section">
      <div class="section-head">
        <h2>{hasBaseline ? "Visual comparison" : "Screenshots"}</h2>
        <div class="spacer"></div>
        {#if verdictBadge && verdict}
          <span class="status {verdictBadge.cls} verdict-badge" title={`Agent verdict · ${verdict.model}`}>
            <span class="dot"></span>Agent: {verdictBadge.label}{#if verdict.confidence != null} · {verdict.confidence.toFixed(2)}{/if}
          </span>
        {/if}
        {#if session.isAdmin && !expired}
          <button class="btn btn-secondary" onclick={promote} disabled={promoting}>
            {promoting ? "Promoting…" : hasBaseline ? "Re-promote to baseline" : "Promote to baseline"}
          </button>
        {/if}
      </div>
      {#if verdict}
        <details class="verdict-detail">
          <summary>Agent reasoning<span class="sub"> · {verdict.model}</span></summary>
          <p class="verdict-reasoning">{verdict.reasoning}</p>
        </details>
      {/if}
      {#if promoteMsg}
        <p class="runline sub">{promoteMsg}</p>
      {/if}
      {#if runLoading}
        <p class="empty">Loading artifacts…</p>
      {:else if expired}
        <!-- Reaped by the retention job (#17): the run row stays, its artifacts don't. -->
        <p class="empty">Artifacts expired — screenshots for this run were removed under the project's retention window.</p>
      {:else if orderedViewports.length === 0}
        <p class="empty">This run produced no screenshots.</p>
      {:else if hasBaseline}
        <div class="cmp-list">
          {#each orderedViewports as vp (vp)}
            {@const d = diffs[vp]}
            <div class="cmp">
              <div class="cmp-head">
                <span class="vp">{vp}</span>
                {#if d}
                  <span class="pill" class:pill-ok={!regressed(d.pct)} class:pill-fail={regressed(d.pct)}>
                    {(d.pct * 100).toFixed(2)}% diff
                  </span>
                  {#if d.url === null}<span class="sub">dimensions changed — failed</span>{/if}
                {:else}
                  <span class="sub">no baseline for this viewport</span>
                {/if}
              </div>
              <div class="triptych">
                <figure class="shot">
                  <figcaption class="sub">Baseline</figcaption>
                  {#if baseline[vp]}
                    <a href={baseline[vp]} target="_blank" rel="noopener">
                      <img src={baseline[vp]} alt={`baseline at ${vp}`} loading="lazy" />
                    </a>
                  {:else}
                    <div class="ph">—</div>
                  {/if}
                </figure>
                <figure class="shot">
                  <figcaption class="sub">Current</figcaption>
                  {#if screenshots[vp]}
                    <a href={screenshots[vp]} target="_blank" rel="noopener">
                      <img src={screenshots[vp]} alt={`current ${vp}`} loading="lazy" />
                    </a>
                  {:else}
                    <div class="ph">—</div>
                  {/if}
                </figure>
                <figure class="shot">
                  <figcaption class="sub">Diff</figcaption>
                  {#if d?.url}
                    <a href={d.url} target="_blank" rel="noopener">
                      <img src={d.url} alt={`diff at ${vp}`} loading="lazy" />
                    </a>
                  {:else}
                    <div class="ph">—</div>
                  {/if}
                </figure>
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <div class="shots">
          {#each orderedViewports as vp (vp)}
            <figure class="shot">
              <figcaption class="sub">{vp}</figcaption>
              <a href={screenshots[vp]} target="_blank" rel="noopener">
                <img src={screenshots[vp]} alt={`${check.path} at ${vp}`} loading="lazy" />
              </a>
            </figure>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
{/if}

<style>
  .stripe {
    display: flex;
    gap: 2px;
    flex-wrap: wrap;
    margin-bottom: var(--s3, 0.75rem);
  }
  /* Agent verdict badge (#04): the shared .status dot+word badge, boxed so it reads
     as a distinct chip sitting beside the human promote-to-baseline control. */
  .verdict-badge {
    padding: 3px 10px;
    border: 1px solid var(--border);
    border-radius: var(--r-full);
    background: var(--panel-2);
  }
  /* The agent's reasoning + model, collapsed by default so it never crowds the diff. */
  .verdict-detail {
    margin: 0 0 var(--s3);
  }
  .verdict-detail summary {
    cursor: pointer;
    font-size: var(--t-label);
    color: var(--ink-muted);
  }
  .verdict-reasoning {
    margin: var(--s2) 0 0;
    font-size: var(--t-label);
    color: var(--ink-muted);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .seg {
    width: 10px;
    height: 22px;
    border-radius: 2px;
    background: color-mix(in oklch, var(--ok) 55%, var(--bg));
  }
  .seg.fail {
    background: var(--fail-solid);
  }
  .section-head.incident-open h2 {
    color: var(--fail-ink);
  }
  .shots {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 1rem;
  }
  .shot {
    margin: 0;
    border: 1px solid var(--border, #e2e2e2);
    border-radius: 8px;
    overflow: hidden;
    background: var(--surface, #fff);
  }
  .shot figcaption {
    padding: 0.4rem 0.6rem;
    text-transform: capitalize;
  }
  .shot img {
    display: block;
    width: 100%;
    height: auto;
  }
  tr.selected {
    background: var(--panel-2);
  }
  .cmp-list {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }
  .cmp-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .cmp-head .vp {
    font-weight: 600;
    text-transform: capitalize;
  }
  .triptych {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.75rem;
  }
  .ph {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 120px;
    color: var(--ink-subtle);
    background: var(--panel-2);
  }
  .sig-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .sig-vp-head .vp {
    font-weight: 600;
    text-transform: capitalize;
  }
  .sig-rows {
    list-style: none;
    margin: 0.4rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .sig-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .sig-kind {
    font-weight: 600;
    min-width: 4.5rem;
  }
  .sig-detail {
    flex: 1;
    min-width: 0;
  }
</style>
