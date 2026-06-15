import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { RUNTIME_AGNOSTIC } from "@naikan/kernel-core";
import { createConfigRepo, createPgConfigStore } from "@naikan/config-repo";
import { createLiveChannels, makeIncidentAlerter } from "@naikan/alerter";
import { configFromEnv, createArtifactStore, type ArtifactStore } from "@naikan/baseline-store";
import { db } from "./db.ts";
import { createAuth } from "./auth/service.ts";
import { createApiApp } from "./auth/routes.ts";
import { createConfigApp } from "./config/routes.ts";
import { createHeartbeatApp } from "./heartbeat/routes.ts";
import { createGroupApp } from "./group/routes.ts";
import { createIncidentApp } from "./incident/routes.ts";
import { createDashboardApp } from "./dashboard/routes.ts";
import { createUICheckApp, type EnqueueUIRun } from "./uicheck/routes.ts";
import { createHealthApp, createPgHealthProbe, thresholdsFromEnv } from "./health/routes.ts";
import { createPgSessionStore, createPgUserStore } from "./auth/pg-stores.ts";

/** The worker task identifier for UI runs (must match apps/worker UICHECK_TASK). */
const UICHECK_TASK = "uicheck-run";

/**
 * "Run now" for UI checks hands a job to the graphile-worker queue rather than
 * running Playwright in this Bun process (ADR-0001/ADR-0006). graphile-worker is
 * dynamically imported on first use so a misconfigured / DB-less boot never breaks
 * `/health`, and the worker (not the API) owns installing the queue schema.
 */
function createUIRunEnqueuer(): EnqueueUIRun {
  let utilsPromise: ReturnType<typeof import("graphile-worker").makeWorkerUtils> | undefined;
  return async (checkId) => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    if (!utilsPromise) {
      utilsPromise = import("graphile-worker").then((gw) =>
        gw.makeWorkerUtils({ connectionString }),
      );
    }
    const utils = await utilsPromise;
    await utils.addJob(UICHECK_TASK, { checkId }, { jobKey: `uicheck:${checkId}`, jobKeyMode: "replace" });
  };
}

/** Lazily build the artifact store from S3_* env on first use (boots without S3). */
function createLazyStore(): Pick<ArtifactStore, "get" | "put" | "copy" | "presignGet"> {
  let store: ArtifactStore | undefined;
  const get = (): ArtifactStore => {
    if (!store) store = createArtifactStore(configFromEnv());
    return store;
  };
  return {
    get: (key) => get().get(key),
    put: (key, body, contentType) => get().put(key, body, contentType),
    // Promote-to-baseline (#12) copies run screenshots into the baseline subtree
    // and writes the baseline manifest — both go through the same lazy store.
    copy: (src, dst) => get().copy(src, dst),
    presignGet: (key, ttl) => get().presignGet(key, ttl),
  };
}

// Directory holding the Vite-built SPA. Relative to the repo root (where `bun dev`
// / `bun start` run from). Overridable via WEB_DIST for other layouts.
const WEB_DIST = process.env.WEB_DIST ?? "apps/web-admin/dist";

// Session cookies get the Secure flag outside development (served over HTTPS in prod).
const SECURE_COOKIE = process.env.NODE_ENV === "production";

const app = new Hono();

// Auth + admin Users API, backed by Postgres. The DB connection is lazy (see db.ts),
// so /health and static serving still boot without a live database.
const auth = createAuth({
  users: createPgUserStore(db),
  sessions: createPgSessionStore(db),
});
app.route("/", createApiApp({ auth, secureCookie: SECURE_COOKIE }));

// Project + Site config CRUD (issue #05). config-repo is the only DB-access path
// for these entities and records an audit-log row on every mutation.
const config = createConfigRepo(createPgConfigStore(db));
app.route("/", createConfigApp({ auth, repo: config }));

// Self-monitoring health (issue #18): unauthenticated 200/503 endpoint for an
// external uptime monitor. Queue lag reads graphile-worker's job view; last-run
// freshness reads the config-repo. The DB handle stays lazy (getSql: db), so this
// keeps the "/health boots without a live DB" property — a probe failure (e.g. DB
// unreachable) returns 503 rather than crashing the endpoint.
app.route(
  "/",
  createHealthApp({
    probe: createPgHealthProbe({
      getSql: db,
      repo: config,
      databaseConfigured: () => Boolean(process.env.DATABASE_URL),
    }),
    thresholds: thresholdsFromEnv(),
  }),
);

// Incident alerter (issue #10): email via Resend, Slack via per-project webhook.
// Boots without secrets — email sends just fail best-effort until configured
// (RESEND_API_KEY + ALERT_FROM_EMAIL); APP_BASE_URL drives the alert deep-link.
const alerter = makeIncidentAlerter(
  createLiveChannels({
    resendApiKey: process.env.RESEND_API_KEY ?? "",
    fromEmail: process.env.ALERT_FROM_EMAIL ?? "",
  }),
  process.env.APP_BASE_URL ?? "http://localhost:3000",
);

// Heartbeat checks + run-now (issue #06). Shares the config-repo (the single
// DB-access path for check entities); run-now uses the live heartbeat-runner and
// fires incident alerts (#10) on a transition.
app.route("/", createHeartbeatApp({ auth, repo: config, alerter }));

// UI checks + run-now (issue #11b). Shares the single config-repo; run-now
// enqueues a worker job (Playwright is Node-only), and run detail presigns the
// run's screenshots from the manifest the worker wrote.
app.route(
  "/",
  createUICheckApp({
    auth,
    repo: config,
    enqueueUIRun: createUIRunEnqueuer(),
    store: createLazyStore(),
    // Scoped bearer token for the regression-judge agent (@naikan/mcp). Optional —
    // unset means the agent is not enabled; reads stay session-only.
    agentToken: process.env.NAIKAN_AGENT_TOKEN,
  }),
);

// CheckGroups + inheritance (issue #08). Shares the single config-repo.
app.route("/", createGroupApp({ auth, repo: config }));

// Incidents read API (issue #09). Shares the single config-repo.
app.route("/", createIncidentApp({ auth, repo: config }));

// Read-only dashboard detail views (issue #16): project overview, heartbeat/UI
// check detail, and the cross-project incidents list. All manager-scoped, all
// consuming CheckRun + Incident rows already populated by #06–#14.
app.route("/", createDashboardApp({ auth, repo: config }));

// Serve the built Svelte SPA: static assets first, then fall back to index.html
// so project-side routes resolve. Registered after the API routes so they aren't shadowed.
app.use("/*", serveStatic({ root: WEB_DIST }));
app.get("*", serveStatic({ path: `${WEB_DIST}/index.html` }));

const port = Number(process.env.PORT ?? 3000);
// Bind all interfaces by default so the stack is reachable from other devices on
// the LAN (e.g. testing the mobile layout on a phone). Override with HOST=127.0.0.1.
const hostname = process.env.HOST ?? "0.0.0.0";
console.log(
  `api listening on ${hostname}:${port} — serving SPA from ${WEB_DIST} (kernel runtime-agnostic: ${RUNTIME_AGNOSTIC})`,
);

export default { port, hostname, fetch: app.fetch };
