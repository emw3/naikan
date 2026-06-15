/**
 * UI incident orchestration (#14) — the UI analogue of incident-orchestrator.test.
 * A UI CheckRun feeds the SAME incident-machine as heartbeats, but gated on
 * `criticalFailed` (a critical-severity signal failed), not `status` (which fails
 * on any signal/regression for the digest). UI opens on the first critical fail
 * (N=1) and closes after two consecutive critical-passes.
 */
import { beforeEach, expect, test } from "bun:test";
import { createConfigRepo, type ConfigRepo } from "./repo.ts";
import { InMemoryConfigStore } from "./in-memory-store.ts";
import { applyUIIncidentForRun } from "./incident-orchestrator.ts";
import type { Actor } from "./types.ts";
import type { IncidentAlertEvent } from "@naikan/alerter";

let repo: ConfigRepo;
let projectId: string;
let checkId: string;
const actor: Actor = { id: "system" };
const at = (seconds: number): Date => new Date(seconds * 1000);

/** Record a uicheck run then run the UI orchestrator (mirrors runUIJob). */
async function recordAndApply(
  opts: { criticalFailed: boolean; status?: "pass" | "fail"; error?: string | null },
  seconds: number,
  alerter?: (e: IncidentAlertEvent) => Promise<void>,
): Promise<void> {
  await repo.recordRun({
    checkId,
    checkType: "uicheck",
    startedAt: at(seconds),
    finishedAt: at(seconds),
    status: opts.status ?? (opts.criticalFailed ? "fail" : "pass"),
    latencyMs: 0,
    error: opts.error ?? (opts.criticalFailed ? "load: HTTP 500" : null),
    artifactsRef: `manifest-${seconds}`,
    criticalFailed: opts.criticalFailed,
  });
  await applyUIIncidentForRun({ repo, checkId, alerter });
}

beforeEach(async () => {
  repo = createConfigRepo(new InMemoryConfigStore());
  const project = await repo.createProject({ name: "Acme", alertEmails: ["ops@acme.test"] }, actor);
  projectId = project.id;
  const site = await repo.createSite({ projectId, baseUrl: "https://acme.test" }, actor);
  const check = await repo.createUICheck({ siteId: site.id, path: "/pricing" }, actor);
  checkId = check.id;
});

test("a single critical-signal fail opens a UI incident (N=1)", async () => {
  await recordAndApply({ criticalFailed: true }, 0);
  const open = await repo.getOpenIncident(checkId);
  expect(open).not.toBeNull();
  expect(open!.openedAt).toEqual(at(0));
  expect(open!.runIds).toHaveLength(1);
});

test("a warning-only run failure does NOT open an incident", async () => {
  // status=fail (e.g. a console warning or visual regression) but no critical signal.
  await recordAndApply({ criticalFailed: false, status: "fail", error: "console: 1 error" }, 0);
  expect(await repo.getOpenIncident(checkId)).toBeNull();
});

test("two consecutive critical-passes close the incident with duration", async () => {
  await recordAndApply({ criticalFailed: true }, 0); // opens at t=0
  expect(await repo.getOpenIncident(checkId)).not.toBeNull();

  await recordAndApply({ criticalFailed: false }, 86_400); // 1 day later: 1 pass, not enough
  expect(await repo.getOpenIncident(checkId)).not.toBeNull();

  await recordAndApply({ criticalFailed: false }, 172_800); // 2 days: closes
  expect(await repo.getOpenIncident(checkId)).toBeNull();

  const closed = (await repo.listProjectIncidents(projectId)).find((x) => x.closedAt !== null)!;
  expect(closed.closedAt).toEqual(at(172_800));
  // ≈48h to recovery alert under daily cadence (documented trade-off, #14).
  expect(closed.closedAt!.getTime() - closed.openedAt.getTime()).toBe(172_800 * 1000);
});

test("a warning-only run counts as a recovery pass (critical-healthy)", async () => {
  await recordAndApply({ criticalFailed: true }, 0); // open
  await recordAndApply({ criticalFailed: false, status: "fail", error: "console: 1 error" }, 86_400);
  await recordAndApply({ criticalFailed: false }, 172_800);
  expect(await repo.getOpenIncident(checkId)).toBeNull(); // warning run still closed it
});

test("opening fires a uicheck 'opened' alert with the host+path label", async () => {
  const events: IncidentAlertEvent[] = [];
  await recordAndApply({ criticalFailed: true }, 0, (e) => {
    events.push(e);
    return Promise.resolve();
  });
  expect(events).toHaveLength(1);
  expect(events[0]!.kind).toBe("opened");
  expect(events[0]!.checkType).toBe("uicheck");
  expect(events[0]!.checkLabel).toBe("acme.test/pricing");
  expect(events[0]!.error).toBe("load: HTTP 500");
  expect(events[0]!.routing.alertEmails).toEqual(["ops@acme.test"]);
});

test("closing fires a uicheck 'recovered' alert carrying the downtime", async () => {
  const events: IncidentAlertEvent[] = [];
  const sink = (e: IncidentAlertEvent): Promise<void> => {
    events.push(e);
    return Promise.resolve();
  };
  await recordAndApply({ criticalFailed: true }, 0, sink);
  await recordAndApply({ criticalFailed: false }, 86_400, sink);
  await recordAndApply({ criticalFailed: false }, 172_800, sink);

  const recovered = events.find((e) => e.kind === "recovered")!;
  expect(recovered).toBeDefined();
  expect(recovered.checkType).toBe("uicheck");
  expect(recovered.durationMs).toBe(172_800 * 1000);
});

test("the UI incident appears in the project's incident list", async () => {
  await recordAndApply({ criticalFailed: true }, 0);
  const incidents = await repo.listProjectIncidents(projectId);
  expect(incidents).toHaveLength(1);
  expect(incidents[0]!.checkId).toBe(checkId);
});

test("no critical fail, no incident — clean daily runs are a no-op", async () => {
  await recordAndApply({ criticalFailed: false }, 0);
  await recordAndApply({ criticalFailed: false }, 86_400);
  expect(await repo.getOpenIncident(checkId)).toBeNull();
  expect(await repo.listProjectIncidents(projectId)).toHaveLength(0);
});
