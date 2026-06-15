<script lang="ts">
  import * as api from "./lib/api.ts";
  import type { Project, ProjectInput, User } from "./lib/api.ts";
  import { session } from "./lib/session.svelte.ts";

  let projects = $state<Project[]>([]);
  let managers = $state<User[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  // Inline create form (progressive disclosure — no modal, per DESIGN.md).
  let showCreate = $state(false);
  let form = $state(blankForm());
  let createError = $state<string | null>(null);
  let creating = $state(false);

  function blankForm() {
    return {
      name: "",
      contacts: "",
      slackChannel: "",
      slackWebhookUrl: "",
      alertEmails: "",
      retentionDays: 90,
      assignedManagerId: session.user?.id ?? "",
    };
  }

  async function load() {
    loading = true;
    loadError = null;
    try {
      projects = await api.listProjects();
      // Manager names come from the Users API (admin-only); viewers just see ids absent.
      if (session.isAdmin) managers = await api.listUsers();
    } catch (err) {
      loadError = err instanceof api.ApiError ? err.message : "Could not load projects";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    load();
  });

  function go(id: string) {
    location.hash = `#/projects/${id}`;
  }

  /** Resolve a manager id to an email (managers load admin-only); falls back gracefully. */
  function managerEmail(id: string | null): string {
    if (!id) return "Unassigned";
    return managers.find((m) => m.id === id)?.email ?? "—";
  }

  function resetCreate() {
    showCreate = false;
    form = blankForm();
    createError = null;
  }

  function parseEmails(raw: string): string[] {
    return raw
      .split(/[\n,]/)
      .map((e) => e.trim())
      .filter(Boolean);
  }

  async function create(e: SubmitEvent) {
    e.preventDefault();
    createError = null;
    creating = true;
    const input: ProjectInput = {
      name: form.name.trim(),
      contacts: form.contacts.trim(),
      slackChannel: form.slackChannel.trim() || null,
      slackWebhookUrl: form.slackWebhookUrl.trim() || null,
      alertEmails: parseEmails(form.alertEmails),
      retentionDays: Number(form.retentionDays),
      assignedManagerId: form.assignedManagerId || null,
    };
    try {
      const created = await api.createProject(input);
      resetCreate();
      go(created.id);
    } catch (err) {
      createError = err instanceof api.ApiError ? err.message : "Could not create project";
    } finally {
      creating = false;
    }
  }
</script>

<div class="pagehead">
  <div>
    <h1>Projects</h1>
    <p class="lede">
      {#if !loading}{projects.length}
        {projects.length === 1 ? "project" : "projects"} monitored{/if}
    </p>
  </div>
  <div class="spacer"></div>
  {#if session.isAdmin && !showCreate}
    <button class="btn btn-secondary" onclick={() => (showCreate = true)}>New project</button>
  {/if}
</div>

{#if showCreate}
  <form class="createform" onsubmit={create}>
    <div class="field">
      <label for="cn">Name</label>
      <input id="cn" class="input" autocomplete="off" bind:value={form.name} required />
    </div>
    <div class="field">
      <label for="cm">Account manager</label>
      <select id="cm" class="select" bind:value={form.assignedManagerId}>
        <option value="">Unassigned</option>
        {#each managers as m (m.id)}
          <option value={m.id}>{m.email}</option>
        {/each}
      </select>
    </div>
    <div class="field full">
      <label for="cc">Contacts</label>
      <input
        id="cc"
        class="input"
        placeholder="Names, emails, phone — free text"
        bind:value={form.contacts}
      />
    </div>
    <div class="field">
      <label for="cs">Slack channel</label>
      <input id="cs" class="input" placeholder="#project-acme" bind:value={form.slackChannel} />
    </div>
    <div class="field">
      <label for="cw">Slack webhook URL</label>
      <input
        id="cw"
        class="input"
        type="url"
        placeholder="https://hooks.slack.com/services/…"
        bind:value={form.slackWebhookUrl}
      />
    </div>
    <div class="field">
      <label for="cr">Retention (days)</label>
      <input id="cr" class="input" type="number" min="1" bind:value={form.retentionDays} />
    </div>
    <div class="field full">
      <label for="ce">Alert emails</label>
      <input
        id="ce"
        class="input"
        placeholder="comma-separated, e.g. ops@acme.test, oncall@acme.test"
        bind:value={form.alertEmails}
      />
    </div>
    {#if createError}
      <p class="formerror full" role="alert">{createError}</p>
    {/if}
    <div class="actions">
      <div class="spacer"></div>
      <button class="btn btn-ghost" type="button" onclick={resetCreate} disabled={creating}>
        Cancel
      </button>
      <button class="btn btn-primary" type="submit" disabled={creating}>
        {creating ? "Creating…" : "Create project"}
      </button>
    </div>
  </form>
{/if}

{#if loading}
  <p class="empty">Loading projects…</p>
{:else if loadError}
  <p class="formerror" role="alert">{loadError}</p>
{:else if projects.length === 0}
  <p class="empty">
    No projects yet.{#if session.isAdmin}
      Add your first project to start monitoring its sites.{/if}
  </p>
{:else}
  <div class="panel">
    <div class="panel-head">
      <h2>Portfolio</h2>
      <span class="n">{projects.length}</span>
    </div>
    <div class="tbl-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th>Project</th>
            <th>Account manager</th>
            <th class="num">Retention</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each projects as project (project.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <tr class="link" onclick={() => go(project.id)}>
              <td>
                <a class="t-primary" href={`#/projects/${project.id}`}>{project.name}</a>
                <div class="t-sub">{project.contacts || "No contacts on file"}</div>
              </td>
              <td class="muted">{managerEmail(project.assignedManagerId)}</td>
              <td class="num mono">{project.retentionDays}d</td>
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
  </div>
{/if}
