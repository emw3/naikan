<script lang="ts">
  import * as api from "./lib/api.ts";
  import type { CheckRun, HeartbeatCheck, Site, CheckGroup, UICheck, Severity } from "./lib/api.ts";
  import { session } from "./lib/session.svelte.ts";

  let { siteId }: { siteId: string } = $props();

  let site = $state<Site | null>(null);
  let checks = $state<HeartbeatCheck[]>([]);
  let uichecks = $state<UICheck[]>([]);
  let groups = $state<CheckGroup[]>([]);
  let lastRun = $state<Record<string, CheckRun>>({});
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  // UI-check create/edit form (one form, reused — `uiEditId` null means "creating").
  let uiShowForm = $state(false);
  let uiEditId = $state<string | null>(null);
  let uiForm = $state(uiBlankForm());
  let uiFormError = $state<string | null>(null);
  let uiSaving = $state(false);
  let uiQueued = $state<Record<string, boolean>>({});
  let uiLastRun = $state<Record<string, CheckRun>>({});
  let uiRunError = $state<Record<string, string>>({});
  let uiConfirmDeleteId = $state<string | null>(null);

  // Create / edit form (one form, reused — `editId` null means "creating").
  let showForm = $state(false);
  let editId = $state<string | null>(null);
  let form = $state(blankForm());
  let formError = $state<string | null>(null);
  let saving = $state(false);

  // Per-check transient UI.
  let running = $state<Record<string, boolean>>({});
  let runError = $state<Record<string, string>>({});
  let confirmDeleteId = $state<string | null>(null);

  function blankForm() {
    return {
      groupId: "",
      path: "/",
      assertionKind: "" as "" | "regex" | "jsonpath",
      assertionPattern: "",
      assertionEquals: "",
      certCheck: false,
      dnsCheck: false,
      // type=number inputs bind to number | null (Svelte coerces); null = inherit.
      intervalSeconds: null as number | null,
      alertAfterNFails: null as number | null,
    };
  }

  function formFrom(c: HeartbeatCheck) {
    return {
      groupId: c.groupId ?? "",
      path: c.path,
      assertionKind: (c.bodyAssertion?.kind ?? "") as "" | "regex" | "jsonpath",
      assertionPattern: c.bodyAssertion?.pattern ?? "",
      assertionEquals: c.bodyAssertion?.equals ?? "",
      certCheck: c.certCheck,
      dnsCheck: c.dnsCheck,
      intervalSeconds: c.intervalSeconds,
      alertAfterNFails: c.alertAfterNFails,
    };
  }

  async function load() {
    loading = true;
    loadError = null;
    try {
      site = await api.getSite(siteId);
      groups = await api.listGroups(site.projectId);
      checks = await api.listChecks(siteId);
      uichecks = await api.listUIChecks(siteId);
      // Pull the most recent run per check so each row shows its latest status.
      const runs = await Promise.all(checks.map((c) => api.listRuns(c.id)));
      const map: Record<string, CheckRun> = {};
      checks.forEach((c, i) => {
        const r = runs[i]?.[0];
        if (r) map[c.id] = r;
      });
      lastRun = map;
      // Same for UI checks — most recent run drives the Status column.
      const uiRuns = await Promise.all(uichecks.map((c) => api.listUIRuns(c.id)));
      const uiMap: Record<string, CheckRun> = {};
      uichecks.forEach((c, i) => {
        const r = uiRuns[i]?.[0];
        if (r) uiMap[c.id] = r;
      });
      uiLastRun = uiMap;
    } catch (err) {
      loadError = err instanceof api.ApiError ? err.message : "Could not load site";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void siteId;
    load();
  });

  function startCreate() {
    editId = null;
    form = blankForm();
    formError = null;
    showForm = true;
  }

  function startEdit(c: HeartbeatCheck) {
    editId = c.id;
    form = formFrom(c);
    formError = null;
    showForm = true;
  }

  function cancelForm() {
    showForm = false;
    editId = null;
    formError = null;
  }

  function buildInput(): api.HeartbeatCheckInput {
    const kind = form.assertionKind;
    const bodyAssertion = kind
      ? {
          kind,
          pattern: form.assertionPattern.trim(),
          ...(kind === "jsonpath" && form.assertionEquals.trim()
            ? { equals: form.assertionEquals.trim() }
            : {}),
        }
      : null;
    return {
      groupId: form.groupId || null,
      path: form.path.trim() || "/",
      bodyAssertion,
      certCheck: form.certCheck,
      dnsCheck: form.dnsCheck,
      intervalSeconds: form.intervalSeconds,
      alertAfterNFails: form.alertAfterNFails,
    };
  }

  // System defaults mirror @naikan/config-repo's effective resolver (display only).
  const SYS_INTERVAL = 300;
  const SYS_ALERT_AFTER = 1;

  function selectedGroup(): CheckGroup | null {
    return groups.find((g) => g.id === form.groupId) ?? null;
  }

  // What an empty field will inherit, given the currently-selected group.
  let inheritedInterval = $derived(selectedGroup()?.defaultIntervalSeconds ?? SYS_INTERVAL);
  let inheritedAlertAfter = $derived(selectedGroup()?.defaultAlertAfterNFails ?? SYS_ALERT_AFTER);

  function effectiveInterval(c: HeartbeatCheck): number {
    if (c.intervalSeconds != null) return c.intervalSeconds;
    const g = groups.find((x) => x.id === c.groupId);
    return g?.defaultIntervalSeconds ?? SYS_INTERVAL;
  }
  function effectiveAlertAfter(c: HeartbeatCheck): number {
    if (c.alertAfterNFails != null) return c.alertAfterNFails;
    const g = groups.find((x) => x.id === c.groupId);
    return g?.defaultAlertAfterNFails ?? SYS_ALERT_AFTER;
  }
  function groupName(c: HeartbeatCheck): string | null {
    return groups.find((g) => g.id === c.groupId)?.name ?? null;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    formError = null;
    saving = true;
    try {
      const input = buildInput();
      if (editId) {
        const updated = await api.updateCheck(editId, input);
        checks = checks.map((c) => (c.id === updated.id ? updated : c));
      } else {
        const created = await api.createCheck(siteId, input);
        checks = [...checks, created];
      }
      cancelForm();
    } catch (err) {
      formError = err instanceof api.ApiError ? err.message : "Could not save check";
    } finally {
      saving = false;
    }
  }

  async function removeCheck(id: string) {
    try {
      await api.deleteCheck(id);
      checks = checks.filter((c) => c.id !== id);
      confirmDeleteId = null;
    } catch {
      await load();
    }
  }

  async function runNow(id: string) {
    running = { ...running, [id]: true };
    runError = { ...runError, [id]: "" };
    try {
      const run = await api.runCheck(id);
      lastRun = { ...lastRun, [id]: run };
    } catch (err) {
      runError = {
        ...runError,
        [id]: err instanceof api.ApiError ? err.message : "Run failed",
      };
    } finally {
      running = { ...running, [id]: false };
    }
  }

  // ---- UI checks ----

  function uiBlankForm() {
    return {
      groupId: "",
      path: "/",
      vpMobile: true,
      vpTablet: true,
      vpDesktop: true,
      diffThreshold: 0.01,
      severityLoad: "critical" as Severity,
      severityConsole: "warning" as Severity,
      severitySelector: "warning" as Severity,
      severityPerf: "warning" as Severity,
      // PRD perf budget defaults: LCP < 2.5s, weight < 3 MB, requests < 100.
      perfLcpMs: 2500,
      perfWeightMb: 3,
      perfMaxRequests: 100,
      selectors: "",
      ignoreRegions: "",
    };
  }

  function uiFormFrom(c: UICheck) {
    return {
      groupId: c.groupId ?? "",
      path: c.path,
      vpMobile: c.viewports.includes("mobile"),
      vpTablet: c.viewports.includes("tablet"),
      vpDesktop: c.viewports.includes("desktop"),
      diffThreshold: c.diffThreshold,
      severityLoad: c.severityLoad,
      severityConsole: c.severityConsole,
      severitySelector: c.severitySelector,
      severityPerf: c.severityPerf,
      perfLcpMs: c.perfBudget.lcpMs,
      perfWeightMb: Math.round((c.perfBudget.pageWeightBytes / (1024 * 1024)) * 100) / 100,
      perfMaxRequests: c.perfBudget.maxRequests,
      selectors: c.selectors.join(", "),
      ignoreRegions: c.ignoreRegions.join(", "),
    };
  }

  function startUICreate() {
    uiEditId = null;
    uiForm = uiBlankForm();
    uiFormError = null;
    uiShowForm = true;
  }

  function startUIEdit(c: UICheck) {
    uiEditId = c.id;
    uiForm = uiFormFrom(c);
    uiFormError = null;
    uiShowForm = true;
  }

  function cancelUIForm() {
    uiShowForm = false;
    uiEditId = null;
    uiFormError = null;
  }

  function splitList(s: string): string[] {
    return s
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  }

  function buildUIInput(): api.UICheckInput {
    const viewports = [
      uiForm.vpMobile ? "mobile" : null,
      uiForm.vpTablet ? "tablet" : null,
      uiForm.vpDesktop ? "desktop" : null,
    ].filter((v): v is string => v !== null);
    return {
      groupId: uiForm.groupId || null,
      path: uiForm.path.trim() || "/",
      viewports,
      selectors: splitList(uiForm.selectors),
      ignoreRegions: splitList(uiForm.ignoreRegions),
      perfBudget: {
        lcpMs: uiForm.perfLcpMs,
        pageWeightBytes: Math.round(uiForm.perfWeightMb * 1024 * 1024),
        maxRequests: uiForm.perfMaxRequests,
      },
      diffThreshold: uiForm.diffThreshold,
      severityLoad: uiForm.severityLoad,
      severityConsole: uiForm.severityConsole,
      severitySelector: uiForm.severitySelector,
      severityPerf: uiForm.severityPerf,
    };
  }

  async function saveUI(e: SubmitEvent) {
    e.preventDefault();
    uiFormError = null;
    uiSaving = true;
    try {
      const input = buildUIInput();
      if (uiEditId) {
        const updated = await api.updateUICheck(uiEditId, input);
        uichecks = uichecks.map((c) => (c.id === updated.id ? updated : c));
      } else {
        const created = await api.createUICheck(siteId, input);
        uichecks = [...uichecks, created];
      }
      cancelUIForm();
    } catch (err) {
      uiFormError = err instanceof api.ApiError ? err.message : "Could not save UI check";
    } finally {
      uiSaving = false;
    }
  }

  async function removeUICheck(id: string) {
    try {
      await api.deleteUICheck(id);
      uichecks = uichecks.filter((c) => c.id !== id);
      uiConfirmDeleteId = null;
    } catch {
      await load();
    }
  }

  async function runUINow(id: string) {
    uiRunError = { ...uiRunError, [id]: "" };
    uiQueued = { ...uiQueued, [id]: false };
    try {
      await api.runUICheck(id);
      uiQueued = { ...uiQueued, [id]: true };
    } catch (err) {
      uiRunError = {
        ...uiRunError,
        [id]: err instanceof api.ApiError ? err.message : "Could not queue run",
      };
    }
  }

  function uiGroupName(c: UICheck): string | null {
    return groups.find((g) => g.id === c.groupId)?.name ?? null;
  }

  function signalTags(c: HeartbeatCheck): string[] {
    const tags = ["HTTP"];
    if (c.dnsCheck) tags.push("DNS");
    if (c.certCheck) tags.push("TLS");
    if (c.bodyAssertion) tags.push(c.bodyAssertion.kind === "regex" ? "regex" : "json");
    return tags;
  }

  function hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }
</script>

{#if loading}
  <p class="empty">Loading…</p>
{:else if loadError || !site}
  <p class="formerror" role="alert">{loadError ?? "Site not found"}</p>
{:else}
  <a class="back" href={`#/projects/${site.projectId}/config`}>← Project config</a>

  <div class="pagehead">
    <div>
      <h1>{hostOf(site.baseUrl)}</h1>
      <p class="cv-meta">
        <a class="mono" href={site.baseUrl} target="_blank" rel="noopener">{site.baseUrl}</a>
      </p>
    </div>
    <div class="spacer"></div>
    {#if session.isAdmin && !showForm}
      <button class="btn btn-secondary" onclick={startCreate}>New check</button>
    {/if}
  </div>

  {#if showForm}
    <form class="createform" onsubmit={save}>
      <div class="field">
        <label for="cg">Check group</label>
        <select id="cg" class="select" bind:value={form.groupId}>
          <option value="">No group</option>
          {#each groups as g (g.id)}
            <option value={g.id}>{g.name}</option>
          {/each}
        </select>
      </div>
      <div class="field">
        <label for="cp">Path</label>
        <input id="cp" class="input" placeholder="/health" autocomplete="off" bind:value={form.path} />
      </div>
      <div class="field">
        <label for="ci">Interval (seconds)</label>
        <input id="ci" class="input" type="number" min="1" placeholder={`inherit · ${inheritedInterval}s`} bind:value={form.intervalSeconds} />
        <span class="sub">{form.intervalSeconds != null ? "Overrides the group/default" : `Inherits ${inheritedInterval}s`}</span>
      </div>
      <div class="field">
        <label for="ck">Body assertion</label>
        <select id="ck" class="select" bind:value={form.assertionKind}>
          <option value="">None</option>
          <option value="regex">Regex match</option>
          <option value="jsonpath">JSON path</option>
        </select>
      </div>
      <div class="field">
        <label for="ca">Alert after N fails</label>
        <input id="ca" class="input" type="number" min="1" placeholder={`inherit · ${inheritedAlertAfter}`} bind:value={form.alertAfterNFails} />
        <span class="sub">{form.alertAfterNFails != null ? "Overrides the group/default" : `Inherits ${inheritedAlertAfter}`}</span>
      </div>
      {#if form.assertionKind}
        <div class="field">
          <label for="cpat">{form.assertionKind === "regex" ? "Regex pattern" : "JSON path"}</label>
          <input
            id="cpat"
            class="input"
            placeholder={form.assertionKind === "regex" ? "ok|healthy" : "data.status"}
            bind:value={form.assertionPattern}
          />
        </div>
        {#if form.assertionKind === "jsonpath"}
          <div class="field">
            <label for="ceq">Equals (optional)</label>
            <input id="ceq" class="input" placeholder="green" bind:value={form.assertionEquals} />
          </div>
        {/if}
      {/if}
      <div class="full checkrow">
        <label class="check"><input type="checkbox" bind:checked={form.dnsCheck} /> Resolve DNS</label>
        <label class="check">
          <input type="checkbox" bind:checked={form.certCheck} /> Inspect TLS certificate expiry (https)
        </label>
      </div>
      {#if formError}
        <p class="formerror full" role="alert">{formError}</p>
      {/if}
      <div class="actions">
        <div class="spacer"></div>
        <button class="btn btn-ghost" type="button" onclick={cancelForm} disabled={saving}>Cancel</button>
        <button class="btn btn-primary" type="submit" disabled={saving}>
          {saving ? "Saving…" : editId ? "Save check" : "Create check"}
        </button>
      </div>
    </form>
  {/if}

  <section class="section">
    <div class="section-head">
      <h2>Heartbeat checks</h2>
      <span class="n">{checks.length}</span>
    </div>

    {#if checks.length === 0}
      <p class="empty">
        No checks yet.{#if session.isAdmin} Add one to start monitoring this site.{/if}
      </p>
    {:else}
      <div class="panel">
        <div class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>Check</th>
                <th>Signals</th>
                <th class="num">Schedule</th>
                <th>Last run</th>
                {#if session.isAdmin}<th></th>{/if}
              </tr>
            </thead>
            <tbody>
              {#each checks as check (check.id)}
                <tr>
                  <td>
                    <span class="t-primary mono">{check.path}</span>
                    {#if groupName(check)}<div class="t-sub">{groupName(check)}</div>{/if}
                  </td>
                  <td>
                    <span class="tags">
                      {#each signalTags(check) as t}<span class="tag">{t}</span>{/each}
                    </span>
                  </td>
                  <td class="num muted">
                    every {effectiveInterval(check)}s · alert ×{effectiveAlertAfter(check)}{#if check.intervalSeconds == null}
                      · inherited{/if}
                  </td>
                  <td>
                    {#if running[check.id]}
                      <span class="status idle"><span class="dot"></span>Running…</span>
                    {:else if lastRun[check.id]}
                      {@const r = lastRun[check.id]}
                      <span class="status {r.status === 'pass' ? 'ok' : 'fail'}">
                        <span class="dot"></span>{r.status === "pass" ? "Pass" : "Fail"}
                      </span>
                      <span class="lat mono">{r.latencyMs} ms</span>
                    {:else}
                      <span class="status idle"><span class="dot"></span>Never run</span>
                    {/if}
                  </td>
                  {#if session.isAdmin}
                    <td class="shrink">
                      <span class="t-actions">
                        <button
                          class="btn btn-secondary"
                          onclick={() => runNow(check.id)}
                          disabled={running[check.id]}
                        >
                          Run now
                        </button>
                        <button class="btn btn-ghost" onclick={() => startEdit(check)}>Edit</button>
                        {#if confirmDeleteId === check.id}
                          <span class="confirm">
                            Delete?
                            <button class="btn btn-danger" onclick={() => removeCheck(check.id)}>Yes</button>
                            <button class="btn btn-ghost" onclick={() => (confirmDeleteId = null)}>No</button>
                          </span>
                        {:else}
                          <button class="btn btn-danger" onclick={() => (confirmDeleteId = check.id)}>
                            Remove
                          </button>
                        {/if}
                      </span>
                    </td>
                  {/if}
                </tr>
                {#if runError[check.id]}
                  <tr class="detail-row">
                    <td colspan="5"><p class="formerror" role="alert">{runError[check.id]}</p></td>
                  </tr>
                {:else if lastRun[check.id]?.status === "fail" && lastRun[check.id]?.error}
                  <tr class="detail-row">
                    <td colspan="5"><p class="runfail mono">{lastRun[check.id]!.error}</p></td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}
  </section>

  <section class="section">
    <div class="section-head">
      <h2>UI checks</h2>
      <span class="n">{uichecks.length}</span>
      <div class="spacer"></div>
      {#if session.isAdmin && !uiShowForm}
        <button class="btn btn-secondary" onclick={startUICreate}>New UI check</button>
      {/if}
    </div>

    {#if uiShowForm}
      <form class="createform" onsubmit={saveUI}>
        <div class="field">
          <label for="ug">Check group</label>
          <select id="ug" class="select" bind:value={uiForm.groupId}>
            <option value="">No group</option>
            {#each groups as g (g.id)}
              <option value={g.id}>{g.name}</option>
            {/each}
          </select>
        </div>
        <div class="field">
          <label for="up">Path</label>
          <input id="up" class="input" placeholder="/pricing" autocomplete="off" bind:value={uiForm.path} />
        </div>
        <div class="field full">
          <label for="uvp">Viewports</label>
          <div class="checkrow" id="uvp">
            <label class="check"><input type="checkbox" bind:checked={uiForm.vpMobile} /> Mobile</label>
            <label class="check"><input type="checkbox" bind:checked={uiForm.vpTablet} /> Tablet</label>
            <label class="check"><input type="checkbox" bind:checked={uiForm.vpDesktop} /> Desktop</label>
          </div>
        </div>
        <div class="field">
          <label for="udt">Diff threshold (0–1)</label>
          <input id="udt" class="input" type="number" min="0" max="1" step="0.01" bind:value={uiForm.diffThreshold} />
        </div>
        <div class="field">
          <label for="usl">Load signal severity</label>
          <select id="usl" class="select" bind:value={uiForm.severityLoad}>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
          </select>
        </div>
        <div class="field">
          <label for="usc">Console signal severity</label>
          <select id="usc" class="select" bind:value={uiForm.severityConsole}>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
          </select>
        </div>
        <div class="field">
          <label for="uss">Selector signal severity</label>
          <select id="uss" class="select" bind:value={uiForm.severitySelector}>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
          </select>
        </div>
        <div class="field">
          <label for="usp">Perf signal severity</label>
          <select id="usp" class="select" bind:value={uiForm.severityPerf}>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
          </select>
        </div>
        <div class="field">
          <label for="upl">Perf budget — LCP (ms)</label>
          <input id="upl" class="input" type="number" min="1" step="100" bind:value={uiForm.perfLcpMs} />
        </div>
        <div class="field">
          <label for="upw">Perf budget — page weight (MB)</label>
          <input id="upw" class="input" type="number" min="0.1" step="0.1" bind:value={uiForm.perfWeightMb} />
        </div>
        <div class="field">
          <label for="upr">Perf budget — max requests</label>
          <input id="upr" class="input" type="number" min="1" step="1" bind:value={uiForm.perfMaxRequests} />
        </div>
        <div class="field full">
          <label for="usel">Required selectors (comma-separated)</label>
          <input id="usel" class="input" placeholder="#hero, .cta" autocomplete="off" bind:value={uiForm.selectors} />
        </div>
        <div class="field full">
          <label for="uig">Ignore regions (comma-separated CSS selectors)</label>
          <input id="uig" class="input" placeholder=".carousel" autocomplete="off" bind:value={uiForm.ignoreRegions} />
        </div>
        {#if uiFormError}
          <p class="formerror full" role="alert">{uiFormError}</p>
        {/if}
        <div class="actions">
          <div class="spacer"></div>
          <button class="btn btn-ghost" type="button" onclick={cancelUIForm} disabled={uiSaving}>Cancel</button>
          <button class="btn btn-primary" type="submit" disabled={uiSaving}>
            {uiSaving ? "Saving…" : uiEditId ? "Save UI check" : "Create UI check"}
          </button>
        </div>
      </form>
    {/if}

    {#if uichecks.length === 0}
      <p class="empty">
        No UI checks yet.{#if session.isAdmin} Add one to capture this site's pages.{/if}
      </p>
    {:else}
      <div class="panel">
        <div class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>Check</th>
                <th>Viewports</th>
                <th class="num">Diff threshold</th>
                <th>Status</th>
                {#if session.isAdmin}<th></th>{/if}
              </tr>
            </thead>
            <tbody>
              {#each uichecks as check (check.id)}
                <tr>
                  <td>
                    <a class="t-primary mono" href={`#/uichecks/${check.id}`}>{check.path}</a>
                    {#if uiGroupName(check)}<div class="t-sub">{uiGroupName(check)}</div>{/if}
                  </td>
                  <td>
                    <span class="tags">
                      {#each check.viewports as v}<span class="tag">{v}</span>{/each}
                    </span>
                  </td>
                  <td class="num mono">{check.diffThreshold}</td>
                  <td>
                    {#if uiQueued[check.id]}
                      <span class="status idle"><span class="dot"></span>Queued</span>
                    {:else if uiLastRun[check.id]}
                      {@const r = uiLastRun[check.id]}
                      <span class="status {r.status === 'pass' ? 'ok' : 'fail'}">
                        <span class="dot"></span>{r.status === "pass" ? "Pass" : "Fail"}
                      </span>
                      <span class="lat mono">{r.latencyMs} ms</span>
                    {:else}
                      <span class="status idle"><span class="dot"></span>Never run</span>
                    {/if}
                  </td>
                  {#if session.isAdmin}
                    <td class="shrink">
                      <span class="t-actions">
                        <button class="btn btn-secondary" onclick={() => runUINow(check.id)}>Run now</button>
                        <button class="btn btn-ghost" onclick={() => startUIEdit(check)}>Edit</button>
                        {#if uiConfirmDeleteId === check.id}
                          <span class="confirm">
                            Delete?
                            <button class="btn btn-danger" onclick={() => removeUICheck(check.id)}>Yes</button>
                            <button class="btn btn-ghost" onclick={() => (uiConfirmDeleteId = null)}>No</button>
                          </span>
                        {:else}
                          <button class="btn btn-danger" onclick={() => (uiConfirmDeleteId = check.id)}>
                            Remove
                          </button>
                        {/if}
                      </span>
                    </td>
                  {/if}
                </tr>
                {#if uiRunError[check.id]}
                  <tr class="detail-row">
                    <td colspan="5"><p class="formerror" role="alert">{uiRunError[check.id]}</p></td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}
  </section>
{/if}

<style>
  .tags {
    display: inline-flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .lat {
    margin-left: 8px;
    color: var(--ink-muted);
    font-size: var(--t-caption);
  }
  /* a full-width detail line (run error / failure) tucked under its check row */
  .detail-row td {
    padding-top: 0;
    border-bottom: 1px solid var(--separator);
  }
  .detail-row p {
    margin: 0;
    font-size: var(--t-label);
  }
  .runfail {
    color: var(--fail-ink);
    white-space: normal;
    word-break: break-word;
  }
</style>
