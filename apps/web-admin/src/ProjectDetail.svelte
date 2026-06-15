<script lang="ts">
  import * as api from "./lib/api.ts";
  import type { Project, Site, User, CheckGroup } from "./lib/api.ts";
  import { session } from "./lib/session.svelte.ts";

  let { projectId }: { projectId: string } = $props();

  let project = $state<Project | null>(null);
  let sites = $state<Site[]>([]);
  let managers = $state<User[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  // Project edit form.
  let editing = $state(false);
  let form = $state(emptyForm());
  let editError = $state<string | null>(null);
  let saving = $state(false);
  let confirmDelete = $state(false);

  // Site sub-forms.
  let showAddSite = $state(false);
  let newSiteUrl = $state("");
  let siteError = $state<string | null>(null);
  let savingSite = $state(false);
  let editSiteId = $state<string | null>(null);
  let editSiteUrl = $state("");
  let confirmSiteId = $state<string | null>(null);

  // Check group sub-forms.
  let groups = $state<CheckGroup[]>([]);
  let showAddGroup = $state(false);
  let groupForm = $state(blankGroupForm());
  let groupError = $state<string | null>(null);
  let savingGroup = $state(false);
  let editGroupId = $state<string | null>(null);
  let confirmGroupId = $state<string | null>(null);

  // Incidents (issue #09): open (count + oldest) + recently recovered (duration).
  let openIncidents = $state<api.Incident[]>([]);
  let closedIncidents = $state<api.Incident[]>([]);

  function blankGroupForm() {
    return {
      name: "",
      // type=number inputs bind to number | null (Svelte coerces); null = inherit.
      defaultIntervalSeconds: null as number | null,
      defaultAlertAfterNFails: null as number | null,
      slackChannel: "",
      alertEmails: "",
    };
  }

  function groupFormFrom(g: CheckGroup) {
    return {
      name: g.name,
      defaultIntervalSeconds: g.defaultIntervalSeconds,
      defaultAlertAfterNFails: g.defaultAlertAfterNFails,
      slackChannel: g.defaultAlertRouting?.slackChannel ?? "",
      alertEmails: g.defaultAlertRouting?.alertEmails.join(", ") ?? "",
    };
  }

  function emptyForm() {
    return {
      name: "",
      contacts: "",
      slackChannel: "",
      slackWebhookUrl: "",
      alertEmails: "",
      retentionDays: 90,
      assignedManagerId: "",
    };
  }

  function formFrom(c: Project) {
    return {
      name: c.name,
      contacts: c.contacts,
      slackChannel: c.slackChannel ?? "",
      slackWebhookUrl: c.slackWebhookUrl ?? "",
      alertEmails: c.alertEmails.join(", "),
      retentionDays: c.retentionDays,
      assignedManagerId: c.assignedManagerId ?? "",
    };
  }

  let managerEmail = $derived(
    managers.find((m) => m.id === project?.assignedManagerId)?.email ?? null,
  );

  async function load() {
    loading = true;
    loadError = null;
    try {
      const [c, s, g, incidents] = await Promise.all([
        api.getProject(projectId),
        api.listSites(projectId),
        api.listGroups(projectId),
        api.getProjectIncidents(projectId),
      ]);
      project = c;
      sites = s;
      groups = g;
      openIncidents = incidents.open;
      closedIncidents = incidents.closed;
      if (session.isAdmin) managers = await api.listUsers();
    } catch (err) {
      loadError = err instanceof api.ApiError ? err.message : "Could not load project";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    // Re-run when the routed projectId changes.
    void projectId;
    load();
  });

  function parseEmails(raw: string): string[] {
    return raw
      .split(/[\n,]/)
      .map((e) => e.trim())
      .filter(Boolean);
  }

  function startEdit() {
    if (!project) return;
    form = formFrom(project);
    editError = null;
    editing = true;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!project) return;
    editError = null;
    saving = true;
    try {
      project = await api.updateProject(project.id, {
        name: form.name.trim(),
        contacts: form.contacts.trim(),
        slackChannel: form.slackChannel.trim() || null,
        slackWebhookUrl: form.slackWebhookUrl.trim() || null,
        alertEmails: parseEmails(form.alertEmails),
        retentionDays: Number(form.retentionDays),
        assignedManagerId: form.assignedManagerId || null,
      });
      editing = false;
    } catch (err) {
      editError = err instanceof api.ApiError ? err.message : "Could not save project";
    } finally {
      saving = false;
    }
  }

  async function removeProject() {
    if (!project) return;
    try {
      await api.deleteProject(project.id);
      location.hash = "#/projects";
    } catch {
      confirmDelete = false;
      await load();
    }
  }

  async function addSite(e: SubmitEvent) {
    e.preventDefault();
    if (!project) return;
    siteError = null;
    savingSite = true;
    try {
      const created = await api.createSite(project.id, newSiteUrl.trim());
      sites = [...sites, created];
      newSiteUrl = "";
      showAddSite = false;
    } catch (err) {
      siteError = err instanceof api.ApiError ? err.message : "Could not add site";
    } finally {
      savingSite = false;
    }
  }

  function startEditSite(s: Site) {
    editSiteId = s.id;
    editSiteUrl = s.baseUrl;
    siteError = null;
  }

  async function saveSite(e: SubmitEvent) {
    e.preventDefault();
    if (!editSiteId) return;
    siteError = null;
    savingSite = true;
    try {
      const updated = await api.updateSite(editSiteId, editSiteUrl.trim());
      sites = sites.map((s) => (s.id === updated.id ? updated : s));
      editSiteId = null;
    } catch (err) {
      siteError = err instanceof api.ApiError ? err.message : "Could not save site";
    } finally {
      savingSite = false;
    }
  }

  async function removeSite(id: string) {
    try {
      await api.deleteSite(id);
      sites = sites.filter((s) => s.id !== id);
      confirmSiteId = null;
    } catch {
      await load();
    }
  }

  function buildGroupInput(): api.CheckGroupInput {
    const slack = groupForm.slackChannel.trim();
    const emails = parseEmails(groupForm.alertEmails);
    const routing = slack || emails.length ? { slackChannel: slack || null, alertEmails: emails } : null;
    return {
      name: groupForm.name.trim(),
      defaultIntervalSeconds: groupForm.defaultIntervalSeconds,
      defaultAlertAfterNFails: groupForm.defaultAlertAfterNFails,
      defaultAlertRouting: routing,
    };
  }

  function startAddGroup() {
    editGroupId = null;
    groupForm = blankGroupForm();
    groupError = null;
    showAddGroup = true;
  }

  function startEditGroup(g: CheckGroup) {
    editGroupId = g.id;
    groupForm = groupFormFrom(g);
    groupError = null;
    showAddGroup = true;
  }

  async function saveGroup(e: SubmitEvent) {
    e.preventDefault();
    if (!project) return;
    groupError = null;
    savingGroup = true;
    try {
      const input = buildGroupInput();
      if (editGroupId) {
        const updated = await api.updateGroup(editGroupId, input);
        groups = groups.map((g) => (g.id === updated.id ? updated : g));
      } else {
        const created = await api.createGroup(project.id, input);
        groups = [...groups, created];
      }
      showAddGroup = false;
      editGroupId = null;
    } catch (err) {
      groupError = err instanceof api.ApiError ? err.message : "Could not save check group";
    } finally {
      savingGroup = false;
    }
  }

  async function removeGroup(id: string) {
    try {
      await api.deleteGroup(id);
      groups = groups.filter((g) => g.id !== id);
      confirmGroupId = null;
    } catch {
      await load();
    }
  }

  function hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  function formatWhen(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  /** Humanise a millisecond span as `Xm` or `Xh Ym`. */
  function formatDuration(ms: number): string {
    const mins = Math.max(0, Math.round(ms / 60_000));
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  /** ISO timestamps sort lexicographically, so reduce picks the earliest opened. */
  function oldestOpenedAt(): string | null {
    if (openIncidents.length === 0) return null;
    return openIncidents.reduce((min, i) => (i.openedAt < min ? i.openedAt : min), openIncidents[0].openedAt);
  }

  function downSinceOpened(i: api.Incident): string {
    return formatDuration(Date.now() - new Date(i.openedAt).getTime());
  }

  function recoveredDuration(i: api.Incident): string {
    if (!i.closedAt) return "—";
    return formatDuration(new Date(i.closedAt).getTime() - new Date(i.openedAt).getTime());
  }
</script>

<a class="back" href={`#/projects/${projectId}`}>← Overview</a>

{#if loading}
  <p class="empty">Loading…</p>
{:else if loadError || !project}
  <p class="formerror" role="alert">{loadError ?? "Project not found"}</p>
{:else}
  <div class="pagehead">
    <div>
      <h1>{project.name}</h1>
      <p class="cv-meta">
        {#if managerEmail}<span>{managerEmail}</span><span class="sep"></span>{/if}
        <span>{project.retentionDays}-day retention</span>
        {#if project.slackChannel}<span class="sep"></span><span>{project.slackChannel}</span>{/if}
      </p>
    </div>
    <div class="spacer"></div>
    {#if session.isAdmin && !editing}
      <button class="btn btn-secondary" onclick={startEdit}>Edit</button>
    {/if}
  </div>

  {#if editing}
    <form class="createform" onsubmit={save}>
      <div class="field">
        <label for="en">Name</label>
        <input id="en" class="input" autocomplete="off" bind:value={form.name} required />
      </div>
      <div class="field">
        <label for="em">Account manager</label>
        <select id="em" class="select" bind:value={form.assignedManagerId}>
          <option value="">Unassigned</option>
          {#each managers as m (m.id)}
            <option value={m.id}>{m.email}</option>
          {/each}
        </select>
      </div>
      <div class="field full">
        <label for="ec">Contacts</label>
        <input id="ec" class="input" bind:value={form.contacts} />
      </div>
      <div class="field">
        <label for="es">Slack channel</label>
        <input id="es" class="input" placeholder="#project-acme" bind:value={form.slackChannel} />
      </div>
      <div class="field">
        <label for="ew">Slack webhook URL</label>
        <input
          id="ew"
          class="input"
          type="url"
          placeholder="https://hooks.slack.com/services/…"
          bind:value={form.slackWebhookUrl}
        />
      </div>
      <div class="field">
        <label for="er">Retention (days)</label>
        <input id="er" class="input" type="number" min="1" bind:value={form.retentionDays} />
      </div>
      <div class="field full">
        <label for="ee">Alert emails</label>
        <input id="ee" class="input" placeholder="comma-separated" bind:value={form.alertEmails} />
      </div>
      {#if editError}
        <p class="formerror full" role="alert">{editError}</p>
      {/if}
      <div class="actions">
        {#if !confirmDelete}
          <button class="btn btn-danger" type="button" onclick={() => (confirmDelete = true)}>
            Delete project
          </button>
        {:else}
          <span class="confirm">
            Delete this project and its sites?
            <button class="btn btn-danger" type="button" onclick={removeProject}>Yes, delete</button>
            <button class="btn btn-ghost" type="button" onclick={() => (confirmDelete = false)}>
              Cancel
            </button>
          </span>
        {/if}
        <div class="spacer"></div>
        <button class="btn btn-ghost" type="button" onclick={() => (editing = false)} disabled={saving}>
          Cancel
        </button>
        <button class="btn btn-primary" type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  {/if}

  <section class="section">
    <div class="section-head" class:incident-open={openIncidents.length > 0}>
      <h2>Incidents</h2>
      <span class="n">{openIncidents.length} open</span>
      <div class="spacer"></div>
    </div>

    {#if openIncidents.length > 0}
      <ul class="rowlist">
        {#each openIncidents as inc (inc.id)}
          <li>
            <div class="datarow">
              <div class="dr-name">
                <span class="nm">Opened {formatWhen(inc.openedAt)}</span>
                <span class="sub">down for {downSinceOpened(inc)}</span>
              </div>
              <span class="pill pill-fail">Open</span>
            </div>
          </li>
        {/each}
      </ul>
      {#if oldestOpenedAt()}
        <p class="sub">Oldest opened {formatWhen(oldestOpenedAt()!)}.</p>
      {/if}
    {:else}
      <p class="empty">No open incidents.</p>
    {/if}

    {#if closedIncidents.length > 0}
      <h3 class="subhead">Recently recovered</h3>
      <ul class="rowlist">
        {#each closedIncidents as inc (inc.id)}
          <li>
            <div class="datarow">
              <div class="dr-name">
                <span class="nm">Recovered {formatWhen(inc.closedAt!)}</span>
                <span class="sub">opened {formatWhen(inc.openedAt)} · down for {recoveredDuration(inc)}</span>
              </div>
              <span class="pill pill-ok">Recovered</span>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="section">
    <div class="section-head">
      <h2>Check groups</h2>
      <span class="n">{groups.length}</span>
      <div class="spacer"></div>
      {#if session.isAdmin && !showAddGroup}
        <button class="btn btn-ghost" onclick={startAddGroup}>Add group</button>
      {/if}
    </div>

    {#if showAddGroup}
      <form class="createform" onsubmit={saveGroup}>
        <div class="field">
          <label for="gn">Name</label>
          <input id="gn" class="input" autocomplete="off" bind:value={groupForm.name} required />
        </div>
        <div class="field">
          <label for="gi">Default interval (seconds)</label>
          <input id="gi" class="input" type="number" min="1" placeholder="system 300" bind:value={groupForm.defaultIntervalSeconds} />
        </div>
        <div class="field">
          <label for="ga">Default alert after N fails</label>
          <input id="ga" class="input" type="number" min="1" placeholder="system 1" bind:value={groupForm.defaultAlertAfterNFails} />
        </div>
        <div class="field">
          <label for="gs">Alert Slack channel</label>
          <input id="gs" class="input" placeholder="#prod-critical" bind:value={groupForm.slackChannel} />
        </div>
        <div class="field full">
          <label for="ge">Alert emails</label>
          <input id="ge" class="input" placeholder="comma-separated" bind:value={groupForm.alertEmails} />
        </div>
        {#if groupError}
          <p class="formerror full" role="alert">{groupError}</p>
        {/if}
        <div class="actions">
          <div class="spacer"></div>
          <button class="btn btn-ghost" type="button" onclick={() => { showAddGroup = false; editGroupId = null; }} disabled={savingGroup}>Cancel</button>
          <button class="btn btn-primary" type="submit" disabled={savingGroup}>
            {savingGroup ? "Saving…" : editGroupId ? "Save group" : "Create group"}
          </button>
        </div>
      </form>
    {/if}

    {#if groups.length === 0}
      <p class="empty">No check groups yet.{#if session.isAdmin} Define a shared policy (interval, alert routing) checks can inherit.{/if}</p>
    {:else}
      <ul class="rowlist">
        {#each groups as group (group.id)}
          <li>
            <div class="datarow">
              <div class="dr-name">
                <span class="nm">{group.name}</span>
                <span class="sub">
                  every {group.defaultIntervalSeconds ?? 300}s · alert after {group.defaultAlertAfterNFails ?? 1}
                  {#if group.defaultAlertRouting?.slackChannel} · {group.defaultAlertRouting.slackChannel}{/if}
                </span>
              </div>
              {#if session.isAdmin}
                {#if confirmGroupId === group.id}
                  <span class="confirm">
                    Remove? Checks in it fall back to defaults.
                    <button class="btn btn-danger" onclick={() => removeGroup(group.id)}>Yes</button>
                    <button class="btn btn-ghost" onclick={() => (confirmGroupId = null)}>No</button>
                  </span>
                {:else}
                  <div class="dr-actions">
                    <button class="btn btn-ghost" onclick={() => startEditGroup(group)}>Edit</button>
                    <button class="btn btn-danger" onclick={() => (confirmGroupId = group.id)}>Remove</button>
                  </div>
                {/if}
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="section">
    <div class="section-head">
      <h2>Sites</h2>
      <span class="n">{sites.length}</span>
      <div class="spacer"></div>
      {#if session.isAdmin && !showAddSite}
        <button class="btn btn-ghost" onclick={() => (showAddSite = true)}>Add site</button>
      {/if}
    </div>

    {#if showAddSite}
      <form class="inlineform" onsubmit={addSite}>
        <input
          class="input"
          type="url"
          placeholder="https://example.com"
          bind:value={newSiteUrl}
          required
        />
        <button class="btn btn-primary" type="submit" disabled={savingSite}>Add</button>
        <button
          class="btn btn-ghost"
          type="button"
          onclick={() => {
            showAddSite = false;
            newSiteUrl = "";
            siteError = null;
          }}>Cancel</button
        >
      </form>
    {/if}
    {#if siteError}
      <p class="formerror" role="alert">{siteError}</p>
    {/if}

    {#if sites.length === 0}
      <p class="empty">
        No sites yet.{#if session.isAdmin} Add a base URL to monitor.{/if}
      </p>
    {:else}
      <ul class="rowlist">
        {#each sites as site (site.id)}
          <li>
            {#if editSiteId === site.id}
              <form class="inlineform" onsubmit={saveSite}>
                <input class="input" type="url" bind:value={editSiteUrl} required />
                <button class="btn btn-primary" type="submit" disabled={savingSite}>Save</button>
                <button class="btn btn-ghost" type="button" onclick={() => (editSiteId = null)}>
                  Cancel
                </button>
              </form>
            {:else}
              <div class="datarow">
                <div class="dr-name">
                  <a class="nm" href={`#/sites/${site.id}`}>{hostOf(site.baseUrl)}</a>
                  <a class="sub mono" href={site.baseUrl} target="_blank" rel="noopener">
                    {site.baseUrl}
                  </a>
                </div>
                {#if session.isAdmin}
                  {#if confirmSiteId === site.id}
                    <span class="confirm">
                      Remove?
                      <button class="btn btn-danger" onclick={() => removeSite(site.id)}>Yes</button>
                      <button class="btn btn-ghost" onclick={() => (confirmSiteId = null)}>No</button>
                    </span>
                  {:else}
                    <div class="dr-actions">
                      <button class="btn btn-ghost" onclick={() => startEditSite(site)}>Edit</button>
                      <button class="btn btn-danger" onclick={() => (confirmSiteId = site.id)}>
                        Remove
                      </button>
                    </div>
                  {/if}
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  /* Loud-red heading when an incident is open; silent otherwise (DESIGN.md). */
  .section-head.incident-open h2 {
    color: var(--fail-ink);
  }
  .subhead {
    margin: var(--s4) 0 var(--s2);
    font-size: var(--t-label);
    font-weight: 600;
    color: var(--ink-muted);
  }
</style>
