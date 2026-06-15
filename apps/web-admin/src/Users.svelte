<script lang="ts">
  import * as api from "./lib/api.ts";
  import type { Role, User } from "./lib/api.ts";
  import { session } from "./lib/session.svelte.ts";

  let users = $state<User[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  // Inline create form (progressive disclosure — no modal, per DESIGN.md).
  let showCreate = $state(false);
  let newEmail = $state("");
  let newPassword = $state("");
  let newRole = $state<Role>("viewer");
  let createError = $state<string | null>(null);
  let creating = $state(false);

  let confirmDeleteId = $state<string | null>(null);

  async function load() {
    loading = true;
    loadError = null;
    try {
      users = await api.listUsers();
    } catch (err) {
      loadError = err instanceof api.ApiError ? err.message : "Could not load users";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    load();
  });

  function resetCreate() {
    showCreate = false;
    newEmail = "";
    newPassword = "";
    newRole = "viewer";
    createError = null;
  }

  async function create(e: SubmitEvent) {
    e.preventDefault();
    createError = null;
    creating = true;
    try {
      await api.createUser({ email: newEmail.trim(), password: newPassword, role: newRole });
      resetCreate();
      await load();
    } catch (err) {
      createError = err instanceof api.ApiError ? err.message : "Could not create user";
    } finally {
      creating = false;
    }
  }

  async function onRoleChange(user: User, role: Role) {
    if (role === user.role) return;
    try {
      const updated = await api.changeRole(user.id, role);
      users = users.map((u) => (u.id === updated.id ? updated : u));
    } catch {
      await load(); // re-sync the select on failure
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteUser(id);
      confirmDeleteId = null;
      await load();
    } catch {
      await load();
    }
  }
</script>

<div class="pagehead">
  <div>
    <h1>Users</h1>
    <p class="lede">
      {#if !loading}{users.length} {users.length === 1 ? "user" : "users"} with access{/if}
    </p>
  </div>
  <div class="spacer"></div>
  {#if !showCreate}
    <button class="btn btn-secondary" onclick={() => (showCreate = true)}>New user</button>
  {/if}
</div>

{#if showCreate}
  <form class="createform" onsubmit={create}>
    <div class="field">
      <label for="ne">Email</label>
      <input id="ne" class="input" type="email" autocomplete="off" bind:value={newEmail} required />
    </div>
    <div class="field">
      <label for="np">Password</label>
      <input
        id="np"
        class="input"
        type="password"
        autocomplete="new-password"
        bind:value={newPassword}
        required
      />
    </div>
    <div class="field">
      <label for="nr">Role</label>
      <select id="nr" class="select" bind:value={newRole}>
        <option value="viewer">Viewer</option>
        <option value="admin">Admin</option>
      </select>
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
        {creating ? "Creating…" : "Create user"}
      </button>
    </div>
  </form>
{/if}

{#if loading}
  <p class="empty">Loading users…</p>
{:else if loadError}
  <p class="formerror" role="alert">{loadError}</p>
{:else}
  <div class="panel">
    <div class="panel-head">
      <h2>Access</h2>
      <span class="n">{users.length}</span>
    </div>
    <div class="tbl-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each users as user (user.id)}
            {@const isSelf = user.id === session.user?.id}
            <tr>
              <td>
                <span class="t-primary">{user.email}</span>
                {#if isSelf}<span class="tag" style="margin-left:6px">You</span>{/if}
              </td>
              <td>
                <select
                  class="select rolesel"
                  value={user.role}
                  disabled={isSelf}
                  aria-label={`Role for ${user.email}`}
                  onchange={(e) => onRoleChange(user, e.currentTarget.value as Role)}
                >
                  <option value="viewer">Viewer</option>
                  <option value="admin">Admin</option>
                </select>
              </td>
              <td class="shrink">
                {#if isSelf}
                  <span></span>
                {:else if confirmDeleteId === user.id}
                  <span class="confirm">
                    Remove?
                    <button class="btn btn-danger" onclick={() => remove(user.id)}>Yes</button>
                    <button class="btn btn-ghost" onclick={() => (confirmDeleteId = null)}>No</button>
                  </span>
                {:else}
                  <button class="btn btn-danger" onclick={() => (confirmDeleteId = user.id)}>
                    Remove
                  </button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
{/if}
