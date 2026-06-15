/**
 * Integration tests for the scheduler tick + heartbeat job handler.
 *
 * These exercise the real path — tick → scheduler decision → enqueue → job
 * handler → CheckRun persisted — against the in-memory config store with an
 * injected clock and a stubbed runner. graphile-worker (the production queue
 * transport, wired in index.ts) is deliberately absent: the scheduling logic
 * lives in `@naikan/scheduler` + these two functions, not in the transport.
 */
import { beforeEach, expect, test } from "bun:test";
import { createConfigRepo, InMemoryConfigStore, type Actor, type ConfigRepo } from "@naikan/config-repo";
import type { CheckRunResult } from "@naikan/heartbeat-runner";
import type { ScheduledJob } from "@naikan/scheduler";
import type { IncidentAlertEvent } from "@naikan/alerter";
import { runHeartbeatJob, type RunCheck } from "./job.ts";
import { runTick } from "./tick.ts";

const actor: Actor = { id: "system" };

/** A clock that can be advanced by hand, for deterministic scheduling. */
function controllableClock(startMs = 0) {
  let nowMs = startMs;
  return {
    now: (): Date => new Date(nowMs),
    advance: (seconds: number): void => {
      nowMs += seconds * 1000;
    },
  };
}

/** A runner stub that always passes, stamping the CheckRun from a clock. */
function passingRunner(now: () => Date): RunCheck {
  return () => {
    const t = now();
    return Promise.resolve<CheckRunResult>({
      status: "pass",
      startedAt: t,
      finishedAt: t,
      latencyMs: 0,
      error: null,
    });
  };
}

let repo: ConfigRepo;

beforeEach(() => {
  repo = createConfigRepo(new InMemoryConfigStore());
});

async function seedCheck(intervalSeconds: number): Promise<string> {
  const project = await repo.createProject({ name: "Acme" }, actor);
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  const check = await repo.createCheck({ siteId: site.id, path: "/health", intervalSeconds }, actor);
  return check.id;
}

// ---- end-to-end demo from the issue: no Run-now, history fills itself ----

test("ticking twice across the interval writes two CheckRuns", async () => {
  const clock = controllableClock(0);
  const checkId = await seedCheck(60);
  const runCheck = passingRunner(clock.now);
  // Synchronous in-memory queue: enqueue runs the handler immediately.
  const enqueue = async (job: ScheduledJob): Promise<void> => {
    await runHeartbeatJob(job.checkId, { repo, runCheck });
  };

  await runTick({ now: clock.now, repo, enqueue }); // t=0: never run → due
  clock.advance(60);
  await runTick({ now: clock.now, repo, enqueue }); // t=60: interval elapsed → due

  expect(await repo.listRuns(checkId)).toHaveLength(2);
});

test("ticking again before the interval elapses does not add a run", async () => {
  const clock = controllableClock(0);
  const checkId = await seedCheck(60);
  const runCheck = passingRunner(clock.now);
  const enqueue = async (job: ScheduledJob): Promise<void> => {
    await runHeartbeatJob(job.checkId, { repo, runCheck });
  };

  await runTick({ now: clock.now, repo, enqueue }); // t=0 → due, one run
  clock.advance(30); // < 60s interval
  await runTick({ now: clock.now, repo, enqueue }); // not due

  expect(await repo.listRuns(checkId)).toHaveLength(1);
});

// ---- tick consults the scheduler (only due checks enqueued) ----

test("runTick enqueues only the checks the scheduler deems due", async () => {
  const clock = controllableClock(100_000);
  // Two checks: one just ran, one never ran.
  const project = await repo.createProject({ name: "Acme" }, actor);
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  const fresh = await repo.createCheck({ siteId: site.id, path: "/a", intervalSeconds: 300 }, actor);
  const stale = await repo.createCheck({ siteId: site.id, path: "/b", intervalSeconds: 300 }, actor);
  // `fresh` ran 10s ago (not due, 300s interval); `stale` never ran (due).
  await repo.recordRun({
    checkId: fresh.id,
    checkType: "heartbeat",
    startedAt: new Date(clock.now().getTime() - 10_000),
    finishedAt: new Date(clock.now().getTime() - 10_000),
    status: "pass",
    latencyMs: 0,
    error: null,
  });

  const enqueued: string[] = [];
  const jobs = await runTick({
    now: clock.now,
    repo,
    enqueue: (job) => {
      enqueued.push(job.checkId);
      return Promise.resolve();
    },
  });

  expect(enqueued).toEqual([stale.id]);
  expect(jobs.heartbeat).toEqual([{ checkId: stale.id }]);
});

// ---- job handler ----

test("runHeartbeatJob records the runner's result as a heartbeat CheckRun", async () => {
  const checkId = await seedCheck(60);
  const failing: RunCheck = () =>
    Promise.resolve<CheckRunResult>({
      status: "fail",
      startedAt: new Date(1000),
      finishedAt: new Date(1200),
      latencyMs: 200,
      error: "HTTP 500",
    });

  const run = await runHeartbeatJob(checkId, { repo, runCheck: failing });

  expect(run?.status).toBe("fail");
  expect(run?.error).toBe("HTTP 500");
  expect(run?.latencyMs).toBe(200);
  expect(run?.checkType).toBe("heartbeat");
  expect(await repo.listRuns(checkId)).toHaveLength(1);
});

test("runHeartbeatJob runs the check against its site's base URL", async () => {
  const checkId = await seedCheck(60);
  const seenBaseUrls: string[] = [];
  const spy: RunCheck = (baseUrl) => {
    seenBaseUrls.push(baseUrl);
    return Promise.resolve<CheckRunResult>({
      status: "pass",
      startedAt: new Date(0),
      finishedAt: new Date(0),
      latencyMs: 0,
      error: null,
    });
  };

  await runHeartbeatJob(checkId, { repo, runCheck: spy });

  expect(seenBaseUrls).toEqual(["https://acme.test"]);
});

test("runHeartbeatJob returns null for an unknown check (no run written)", async () => {
  const run = await runHeartbeatJob("missing", {
    repo,
    runCheck: () =>
      Promise.resolve<CheckRunResult>({
        status: "pass",
        startedAt: new Date(0),
        finishedAt: new Date(0),
        latencyMs: 0,
        error: null,
      }),
  });
  expect(run).toBeNull();
});

// ---- CheckGroup inheritance (issue #08): the tick schedules on the effective interval ----

test("a check with no interval inherits its group's interval for scheduling", async () => {
  const clock = controllableClock(0);
  const project = await repo.createProject({ name: "Acme" }, actor);
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  const group = await repo.createGroup(
    { projectId: project.id, name: "prod", defaultIntervalSeconds: 300 },
    actor,
  );
  const check = await repo.createCheck({ siteId: site.id, path: "/health", groupId: group.id }, actor);
  const runCheck = passingRunner(clock.now);
  const enqueue = async (job: ScheduledJob): Promise<void> => {
    await runHeartbeatJob(job.checkId, { repo, runCheck });
  };

  await runTick({ now: clock.now, repo, enqueue }); // t=0: never run -> due
  clock.advance(120); // < 300s inherited interval -> not due
  await runTick({ now: clock.now, repo, enqueue });
  expect(await repo.listRuns(check.id)).toHaveLength(1);

  clock.advance(180); // now 300s since first run -> due
  await runTick({ now: clock.now, repo, enqueue });
  expect(await repo.listRuns(check.id)).toHaveLength(2);
});

test("a per-check interval override changes the inherited cadence", async () => {
  const clock = controllableClock(0);
  const project = await repo.createProject({ name: "Acme" }, actor);
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  const group = await repo.createGroup(
    { projectId: project.id, name: "prod", defaultIntervalSeconds: 300 },
    actor,
  );
  const check = await repo.createCheck({ siteId: site.id, path: "/health", groupId: group.id }, actor);
  const runCheck = passingRunner(clock.now);
  const enqueue = async (job: ScheduledJob): Promise<void> => {
    await runHeartbeatJob(job.checkId, { repo, runCheck });
  };

  await runTick({ now: clock.now, repo, enqueue }); // t=0 -> due (1 run, inherited 300s)
  await repo.updateCheck(check.id, { intervalSeconds: 60 }, actor); // override to 60s
  clock.advance(60);
  await runTick({ now: clock.now, repo, enqueue }); // 60s elapsed, override -> due
  expect(await repo.listRuns(check.id)).toHaveLength(2);
});

// ---- incident orchestration (issue #09): the job applies a transition per run ----

test("runHeartbeatJob opens an incident after N consecutive fails", async () => {
  const project = await repo.createProject({ name: "Acme" }, actor);
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  const check = await repo.createCheck(
    { siteId: site.id, path: "/health", alertAfterNFails: 2 },
    actor,
  );
  const failing: RunCheck = () =>
    Promise.resolve<CheckRunResult>({
      status: "fail",
      startedAt: new Date(0),
      finishedAt: new Date(0),
      latencyMs: 0,
      error: "down",
    });

  await runHeartbeatJob(check.id, { repo, runCheck: failing });
  expect(await repo.getOpenIncident(check.id)).toBeNull(); // 1 fail < 2

  await runHeartbeatJob(check.id, { repo, runCheck: failing });
  expect(await repo.getOpenIncident(check.id)).not.toBeNull(); // 2 fails → opened
});

// ---- incident alerting (issue #10): the job fires an alert event on transition ----

test("runHeartbeatJob fires an opened alert event when an incident opens", async () => {
  const events: IncidentAlertEvent[] = [];
  const alerter = (e: IncidentAlertEvent): Promise<void> => {
    events.push(e);
    return Promise.resolve();
  };
  const project = await repo.createProject({ name: "Acme", alertEmails: ["ops@acme.test"] }, actor);
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  const check = await repo.createCheck(
    { siteId: site.id, path: "/health", alertAfterNFails: 2 },
    actor,
  );
  const failing: RunCheck = () =>
    Promise.resolve<CheckRunResult>({ status: "fail", startedAt: new Date(0), finishedAt: new Date(0), latencyMs: 0, error: "down" });

  await runHeartbeatJob(check.id, { repo, runCheck: failing, alerter });
  expect(events).toHaveLength(0); // 1 fail < 2

  await runHeartbeatJob(check.id, { repo, runCheck: failing, alerter });
  expect(events).toHaveLength(1);
  expect(events[0]!.kind).toBe("opened");
  expect(events[0]!.checkLabel).toBe("acme.test/health");
});
