/**
 * No-database dev server for manual UI testing of issues #03 (auth/users) and
 * #05 (project + site config).
 *
 * Serves the built SPA + the real auth/users + config API, but backed by the
 * in-memory stores instead of Postgres, pre-seeded with one admin, one viewer,
 * and a sample project + site. Lets you exercise login / Users CRUD / Projects CRUD
 * / role gating end-to-end without a DB.
 *
 *   bun run build:web && bun run apps/api/src/dev-no-db.ts
 *
 * Seeded accounts:
 *   admin@example.com  / admin1234   (admin)
 *   viewer@example.com / viewer1234  (viewer)
 */
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { applyIncidentForRun, createConfigRepo, InMemoryConfigStore } from "@naikan/config-repo";
import { createAuth } from "./auth/service.ts";
import { createApiApp } from "./auth/routes.ts";
import { createConfigApp } from "./config/routes.ts";
import { createHeartbeatApp } from "./heartbeat/routes.ts";
import { createGroupApp } from "./group/routes.ts";
import { createIncidentApp } from "./incident/routes.ts";
import { InMemorySessionStore, InMemoryUserStore } from "./auth/in-memory-stores.ts";

const WEB_DIST = process.env.WEB_DIST ?? "apps/web-admin/dist";
const port = Number(process.env.PORT ?? 3000);

const users = new InMemoryUserStore();
const sessions = new InMemorySessionStore();
const auth = createAuth({ users, sessions });

const admin = await auth.createUser({ email: "admin@example.com", password: "admin1234", role: "admin" });
await auth.createUser({ email: "viewer@example.com", password: "viewer1234", role: "viewer" });

const repo = createConfigRepo(new InMemoryConfigStore());
const sample = await repo.createProject(
  {
    name: "Northwind Coffee",
    contacts: "Mara Ortiz · ops@northwind.test",
    slackChannel: "#project-northwind",
    alertEmails: ["alerts@northwind.test"],
    retentionDays: 90,
    assignedManagerId: admin.id,
  },
  { id: admin.id },
);
const sampleSite = await repo.createSite(
  { projectId: sample.id, baseUrl: "https://example.com" },
  { id: admin.id },
);
const sampleGroup = await repo.createGroup(
  {
    projectId: sample.id,
    name: "prod-critical",
    defaultIntervalSeconds: 300,
    defaultAlertAfterNFails: 2,
    defaultAlertRouting: { slackChannel: "#project-northwind", alertEmails: ["alerts@northwind.test"] },
  },
  { id: admin.id },
);
await repo.createCheck(
  { siteId: sampleSite.id, path: "/", certCheck: true, dnsCheck: true, groupId: sampleGroup.id },
  { id: admin.id },
);

// Seed an open incident on the sample check (2 failing runs → opens; #09) so the
// per-project overview has something to show in the no-DB walkthrough.
const sampleCheck = (await repo.listChecks(sampleSite.id))[0]!;
for (let i = 0; i < 2; i++) {
  await repo.recordRun({
    checkId: sampleCheck.id,
    checkType: "heartbeat",
    startedAt: new Date(Date.now() - (2 - i) * 300_000),
    finishedAt: new Date(Date.now() - (2 - i) * 300_000),
    status: "fail",
    latencyMs: 0,
    error: "connection refused",
  });
  await applyIncidentForRun({ repo, checkId: sampleCheck.id });
}

const app = new Hono();
app.get("/health", (c) => c.text("OK"));
app.route("/", createApiApp({ auth, secureCookie: false }));
app.route("/", createConfigApp({ auth, repo }));
app.route("/", createHeartbeatApp({ auth, repo }));
app.route("/", createGroupApp({ auth, repo }));
app.route("/", createIncidentApp({ auth, repo }));
app.use("/*", serveStatic({ root: WEB_DIST }));
app.get("*", serveStatic({ path: `${WEB_DIST}/index.html` }));

const hostname = process.env.HOST ?? "0.0.0.0"; // bind all interfaces (LAN-reachable); override with HOST=127.0.0.1
console.log(
  `dev-no-db: http://localhost:${port} (bound ${hostname}; in-memory; admin@example.com/admin1234, viewer@example.com/viewer1234)`,
);

export default { port, hostname, fetch: app.fetch };
