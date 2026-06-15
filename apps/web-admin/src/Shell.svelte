<script lang="ts">
  import { session } from "./lib/session.svelte.ts";
  import Users from "./Users.svelte";
  import Projects from "./Projects.svelte";
  import ProjectOverview from "./ProjectOverview.svelte";
  import ProjectDetail from "./ProjectDetail.svelte";
  import HeartbeatDetail from "./HeartbeatDetail.svelte";
  import SiteDetail from "./SiteDetail.svelte";
  import UICheckDetail from "./UICheckDetail.svelte";
  import IncidentsView from "./IncidentsView.svelte";
  import Docs from "./Docs.svelte";

  // Minimal hash routing (matches the prototype's hash-route convention).
  // `#/projects` → list, `#/projects/:id` → read-only overview (the digest/alert
  // deep-link target, #16), `#/projects/:id/config` → admin config, `#/checks/:id`
  // → heartbeat detail, `#/sites/:id` → site config, `#/uichecks/:id` → UI-check
  // detail, `#/incidents` → cross-project incidents, `#/docs` → docs hub
  // (`#/docs/:section` → a hub section), `#/users` → users, else overview.
  interface Route {
    name: string;
    id: string | null;
    sub: string | null;
  }
  function routeFromHash(): Route {
    const parts = (location.hash.replace(/^#\/?/, "") || "overview").split("/");
    return { name: parts[0] || "overview", id: parts[1] ?? null, sub: parts[2] ?? null };
  }
  let route = $state<Route>(routeFromHash());

  $effect(() => {
    const onHash = () => (route = routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  });

  // Mobile off-canvas nav drawer (collapses the sidebar below 880px).
  let navOpen = $state(false);

  function go(r: string) {
    location.hash = `#/${r === "overview" ? "" : r}`;
    navOpen = false; // close the drawer on navigate
  }

  // Resolve the active view, guarding the admin-only Users screen for viewers.
  let view = $derived.by(() => {
    if (route.name === "users") return session.isAdmin ? "users" : "overview";
    if (route.name === "projects") {
      if (!route.id) return "projects";
      return route.sub === "config" ? "project-config" : "project-overview";
    }
    if (route.name === "checks") return route.id ? "heartbeat-detail" : "overview";
    if (route.name === "sites") return route.id ? "site-detail" : "overview";
    if (route.name === "uichecks") return route.id ? "uicheck-detail" : "overview";
    if (route.name === "incidents") return "incidents";
    if (route.name === "docs") return "docs";
    return "overview";
  });
  const PROJECT_VIEWS = [
    "projects",
    "project-overview",
    "project-config",
    "site-detail",
    "heartbeat-detail",
    "uicheck-detail",
  ];
  let navActive = $derived(
    view === "users"
      ? "users"
      : view === "incidents"
        ? "incidents"
        : view === "docs"
          ? "docs"
          : PROJECT_VIEWS.includes(view)
            ? "projects"
            : "overview",
  );

  async function logout() {
    await session.logout();
  }
</script>

<div class="app" class:nav-open={navOpen}>
  <header class="topbar">
    <button
      class="menu-btn"
      aria-label="Open navigation"
      aria-expanded={navOpen}
      onclick={() => (navOpen = true)}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M3 6h18M3 12h18M3 18h18" stroke-linecap="round" />
      </svg>
    </button>
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
    <div class="spacer"></div>
    <div class="who">
      <span class="em">{session.user?.email}</span>
      <span class="role">{session.user?.role}</span>
    </div>
    <button class="btn btn-ghost" onclick={logout}>Log out</button>
  </header>

  <nav class="sidebar" aria-label="Primary">
    <button class="navlink" class:active={navActive === "overview"} onclick={() => go("overview")}>
      Overview
    </button>
    <button class="navlink" class:active={navActive === "projects"} onclick={() => go("projects")}>
      Projects
    </button>
    <button class="navlink" class:active={navActive === "incidents"} onclick={() => go("incidents")}>
      Incidents
    </button>
    <button class="navlink" class:active={navActive === "docs"} onclick={() => go("docs")}>
      Docs
    </button>
    {#if session.isAdmin}
      <button class="navlink" class:active={navActive === "users"} onclick={() => go("users")}>
        Users
      </button>
    {/if}
  </nav>

  <main class="main">
    {#if view === "users"}
      <Users />
    {:else if view === "projects"}
      <Projects />
    {:else if view === "project-overview" && route.id}
      {#key route.id}
        <ProjectOverview projectId={route.id} />
      {/key}
    {:else if view === "project-config" && route.id}
      {#key route.id}
        <ProjectDetail projectId={route.id} />
      {/key}
    {:else if view === "heartbeat-detail" && route.id}
      {#key route.id}
        <HeartbeatDetail checkId={route.id} />
      {/key}
    {:else if view === "site-detail" && route.id}
      {#key route.id}
        <SiteDetail siteId={route.id} />
      {/key}
    {:else if view === "uicheck-detail" && route.id}
      {#key route.id}
        <UICheckDetail checkId={route.id} />
      {/key}
    {:else if view === "incidents"}
      <IncidentsView />
    {:else if view === "docs"}
      <Docs section={route.id} term={route.sub} />
    {:else}
      <div class="pagehead">
        <div>
          <h1>Overview</h1>
          <p class="lede">
            Signed in as {session.user?.email}. Pick a project from
            <a href="#/projects">Projects</a> to see its checks, or jump to
            <a href="#/incidents">Incidents</a>.
          </p>
        </div>
      </div>
    {/if}
  </main>

  <button class="backdrop" aria-label="Close navigation" onclick={() => (navOpen = false)}></button>
</div>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape") navOpen = false;
  }}
/>
