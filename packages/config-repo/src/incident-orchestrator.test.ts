import { beforeEach, expect, test } from "bun:test";
import { createConfigRepo, type ConfigRepo } from "./repo.ts";
import { InMemoryConfigStore } from "./in-memory-store.ts";
import { applyIncidentForRun } from "./incident-orchestrator.ts";
import type { Actor, CheckRunStatus } from "./types.ts";
import type { IncidentAlertEvent } from "@naikan/alerter";

let repo: ConfigRepo;
let projectId: string;
let checkId: string;
const actor: Actor = { id: "system" };
const at = (seconds: number): Date => new Date(seconds * 1000);

/** Record a heartbeat run at `seconds`, then run the orchestrator (mirrors the job). */
async function recordAndApply(status: CheckRunStatus, seconds: number): Promise<void> {
  await repo.recordRun({
    checkId,
    checkType: "heartbeat",
    startedAt: at(seconds),
    finishedAt: at(seconds),
    status,
    latencyMs: 0,
    error: status === "fail" ? "down" : null,
  });
  await applyIncidentForRun({ repo, checkId });
}

beforeEach(async () => {
  repo = createConfigRepo(new InMemoryConfigStore());
  const project = await repo.createProject({ name: "Acme" }, actor);
  projectId = project.id;
  const site = await repo.createSite({ projectId, baseUrl: "https://acme.test" }, actor);
  // alertAfterNFails = 5 → five consecutive fails open one incident (the issue's criterion).
  const check = await repo.createCheck({ siteId: site.id, path: "/health", alertAfterNFails: 5 }, actor);
  checkId = check.id;
});

test("five fails open exactly one incident; two successes close it", async () => {
  for (let i = 0; i < 4; i++) await recordAndApply("fail", i * 60);
  expect(await repo.getOpenIncident(checkId)).toBeNull(); // 4 < 5, still none

  await recordAndApply("fail", 4 * 60); // the 5th fail opens it
  const open = await repo.getOpenIncident(checkId);
  expect(open).not.toBeNull();
  expect(open!.openedAt).toEqual(at(0)); // first fail of the streak
  expect(open!.runIds).toHaveLength(5); // the five failing runs
  expect((await repo.listProjectIncidents(projectId)).filter((x) => x.closedAt === null)).toHaveLength(1);

  await recordAndApply("pass", 300); // one success: not enough to close
  expect(await repo.getOpenIncident(checkId)).not.toBeNull();

  await recordAndApply("pass", 360); // second success closes it
  expect(await repo.getOpenIncident(checkId)).toBeNull();

  const closed = (await repo.listProjectIncidents(projectId)).find((x) => x.closedAt !== null)!;
  expect(closed.closedAt).toEqual(at(360));
  expect(closed.runIds).toHaveLength(7); // 5 fails + 2 closing successes
});

test("a flap that never reaches the threshold opens nothing", async () => {
  // alertAfterNFails = 5, but never 5 consecutive fails.
  await recordAndApply("fail", 0);
  await recordAndApply("pass", 60);
  await recordAndApply("fail", 120);
  expect(await repo.getOpenIncident(checkId)).toBeNull();
  expect(await repo.listProjectIncidents(projectId)).toHaveLength(0);
});

test("applyIncidentForRun is a no-op for an unknown check", async () => {
  expect(await applyIncidentForRun({ repo, checkId: "missing" })).toBeNull();
});

// ---- alerting (issue #10): the orchestrator emits a resolved event per transition ----

test("opening an incident emits an 'opened' event with project routing + check label", async () => {
  const events: IncidentAlertEvent[] = [];
  const alerter = (e: IncidentAlertEvent): Promise<void> => {
    events.push(e);
    return Promise.resolve();
  };
  repo = createConfigRepo(new InMemoryConfigStore());
  const project = await repo.createProject(
    { name: "Acme", alertEmails: ["ops@acme.test"], slackWebhookUrl: "https://hooks.slack.com/x" },
    actor,
  );
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  const check = await repo.createCheck(
    { siteId: site.id, path: "/health", alertAfterNFails: 2 },
    actor,
  );

  await repo.recordRun({ checkId: check.id, checkType: "heartbeat", startedAt: at(0), finishedAt: at(0), status: "fail", latencyMs: 0, error: "down" });
  await applyIncidentForRun({ repo, checkId: check.id, alerter });
  expect(events).toHaveLength(0); // 1 fail < 2, no transition

  await repo.recordRun({ checkId: check.id, checkType: "heartbeat", startedAt: at(60), finishedAt: at(60), status: "fail", latencyMs: 0, error: "still down" });
  await applyIncidentForRun({ repo, checkId: check.id, alerter });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: "opened",
    projectId: project.id,
    projectName: "Acme",
    checkLabel: "acme.test/health",
    error: "still down",
    routing: { alertEmails: ["ops@acme.test"], slackWebhookUrl: "https://hooks.slack.com/x" },
  });
});

test("closing an incident emits a 'recovered' event with duration", async () => {
  const events: IncidentAlertEvent[] = [];
  const alerter = (e: IncidentAlertEvent): Promise<void> => {
    events.push(e);
    return Promise.resolve();
  };
  // check from beforeEach has alertAfterNFails = 5.
  for (let i = 0; i < 5; i++) {
    await repo.recordRun({ checkId, checkType: "heartbeat", startedAt: at(i * 60), finishedAt: at(i * 60), status: "fail", latencyMs: 0, error: "down" });
    await applyIncidentForRun({ repo, checkId, alerter });
  }
  await repo.recordRun({ checkId, checkType: "heartbeat", startedAt: at(360), finishedAt: at(360), status: "pass", latencyMs: 0, error: null });
  await applyIncidentForRun({ repo, checkId, alerter });
  await repo.recordRun({ checkId, checkType: "heartbeat", startedAt: at(420), finishedAt: at(420), status: "pass", latencyMs: 0, error: null });
  await applyIncidentForRun({ repo, checkId, alerter });

  const recovered = events.find((e) => e.kind === "recovered");
  expect(recovered).toBeDefined();
  expect(recovered!.durationMs).toBe(420_000); // 420s - 0s
  expect(recovered!.closedAt).toEqual(at(420));
});

test("re-applying after the transition does not emit a second event (idempotent)", async () => {
  const events: IncidentAlertEvent[] = [];
  const alerter = (e: IncidentAlertEvent): Promise<void> => {
    events.push(e);
    return Promise.resolve();
  };
  for (let i = 0; i < 5; i++) {
    await repo.recordRun({ checkId, checkType: "heartbeat", startedAt: at(i * 60), finishedAt: at(i * 60), status: "fail", latencyMs: 0, error: "down" });
    await applyIncidentForRun({ repo, checkId, alerter });
  }
  expect(events.filter((e) => e.kind === "opened")).toHaveLength(1);
  // Re-run with no new run: incident already open → still-open → no event.
  await applyIncidentForRun({ repo, checkId, alerter });
  expect(events.filter((e) => e.kind === "opened")).toHaveLength(1);
});
