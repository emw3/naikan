/**
 * Playwright smoke spec for the dashboard detail views (issue #16):
 * "a manager logs in, lands on their project overview, and sees their project —
 * and only their project".
 *
 * Runs against an in-process, DB-less server (the in-memory stores, like
 * `dev-no-db.ts`) seeded with one manager (a viewer assigned to a project), that
 * manager's project, and a second project they are NOT assigned to. Drives a real
 * headless Chromium through the built SPA, so it exercises the whole stack:
 * login → manager-scoped `/api/projects` → hash routing → project overview.
 *
 *   bun run --filter @naikan/api test:e2e   # (builds the SPA first)
 */
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { applyIncidentForRun, createConfigRepo, InMemoryConfigStore } from "@naikan/config-repo";
import { chromium } from "playwright";
import { createAuth } from "../src/auth/service.ts";
import { createApiApp } from "../src/auth/routes.ts";
import { createConfigApp } from "../src/config/routes.ts";
import { createDashboardApp } from "../src/dashboard/routes.ts";
import { InMemorySessionStore, InMemoryUserStore } from "../src/auth/in-memory-stores.ts";
import { join } from "node:path";

// Absolute so the dist resolves regardless of the script's cwd (repo root vs the
// package dir under `bun run --filter`). Repo root is three levels up from e2e/.
const WEB_DIST = process.env.WEB_DIST ?? join(import.meta.dir, "../../..", "apps/web-admin/dist");
const MANAGER = { email: "manager@example.com", password: "manager1234" };
const MY_PROJECT = "Northwind Coffee";
const OTHER_PROJECT = "Acme (not mine)";

function fail(msg: string): never {
  console.error(`e2e: FAIL — ${msg}`);
  process.exit(1);
}

// ---- 1. Build a seeded, DB-less app ----------------------------------------
const auth = createAuth({ users: new InMemoryUserStore(), sessions: new InMemorySessionStore() });
const manager = await auth.createUser({ ...MANAGER, role: "viewer" });
const repo = createConfigRepo(new InMemoryConfigStore());

const mine = await repo.createProject({ name: MY_PROJECT, assignedManagerId: manager.id }, { id: null });
await repo.createProject({ name: OTHER_PROJECT }, { id: null }); // unassigned → must be hidden from the manager
const site = await repo.createSite({ projectId: mine.id, baseUrl: "https://northwind.test" }, { id: null });
const check = await repo.createCheck({ siteId: site.id, path: "/health", alertAfterNFails: 1 }, { id: null });
// A couple of recent runs so the overview shows a 24h tally + a healthy badge.
for (const seconds of [60, 30]) {
  await repo.recordRun({
    checkId: check.id,
    checkType: "heartbeat",
    startedAt: new Date(Date.now() - seconds * 1000),
    finishedAt: new Date(Date.now() - seconds * 1000),
    status: "pass",
    latencyMs: 120,
  });
}
await applyIncidentForRun({ repo, checkId: check.id });

const app = new Hono();
app.route("/", createApiApp({ auth, secureCookie: false }));
app.route("/", createConfigApp({ auth, repo }));
app.route("/", createDashboardApp({ auth, repo }));
app.use("/*", serveStatic({ root: WEB_DIST }));
app.get("*", serveStatic({ path: `${WEB_DIST}/index.html` }));

const server = Bun.serve({ port: 0, fetch: app.fetch });
const base = `http://localhost:${server.port}`;
console.log(`e2e: server on ${base} (dist: ${WEB_DIST})`);

// ---- 2. Drive Chromium through the manager flow ----------------------------
const browser = await chromium.launch();
let failure: string | null = null;
try {
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: "networkidle" });

  // Log in as the manager.
  await page.fill("#email", MANAGER.email);
  await page.fill("#password", MANAGER.password);
  await page.click('button[type="submit"]');

  // The Projects list is manager-scoped: their project shows, the other does not.
  await page.goto(`${base}/#/projects`, { waitUntil: "networkidle" });
  await page.getByText(MY_PROJECT).first().waitFor({ state: "visible", timeout: 10_000 });
  if (await page.getByText(OTHER_PROJECT).count()) {
    failure = `manager could see an unassigned project (${OTHER_PROJECT})`;
  }

  // Open the project overview (the digest/alert deep-link target) and confirm the
  // page renders the project + its checks.
  if (!failure) {
    await page.click(`text=${MY_PROJECT}`);
    await page.waitForFunction(() => location.hash.startsWith("#/projects/"), { timeout: 10_000 });
    await page.getByRole("heading", { name: MY_PROJECT }).waitFor({ state: "visible", timeout: 10_000 });
    await page.getByText("/health").first().waitFor({ state: "visible", timeout: 10_000 });
  }
} catch (err) {
  failure = err instanceof Error ? err.message : String(err);
} finally {
  await browser.close();
  server.stop(true);
}

if (failure) fail(failure);
console.log("e2e: PASS — manager logged in, landed on their project overview, saw only their project");
process.exit(0);
