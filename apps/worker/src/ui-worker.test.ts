/**
 * Integration tests for UI-check scheduling + the realtime alert path (issue #14).
 *
 * Exercises the real chain — tick → scheduler decision → enqueue → `runUIJob` →
 * CheckRun → incident machine → alerter — against the in-memory config store with
 * an injected clock and a stubbed `runUI`. graphile-worker is deliberately absent:
 * the UI enqueue is wired to run the job inline, mirroring index.ts which hands
 * `runUIJob` the same alerter heartbeats use.
 */
import { beforeEach, expect, test } from "bun:test";
import {
  createConfigRepo,
  InMemoryConfigStore,
  type Actor,
  type ConfigRepo,
  type UICheckInput,
} from "@naikan/config-repo";
import type { IncidentAlertEvent } from "@naikan/alerter";
import type { ScheduledJob } from "@naikan/scheduler";
import { runUIJob, type RunUI } from "./ui-job.ts";
import { runTick } from "./tick.ts";

const actor: Actor = { id: "system" };
const DAY = 86_400;

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

/** In-memory artifact sink — UI jobs put screenshots + a manifest; no baseline get. */
function fakeStore() {
  const objects: Record<string, Buffer> = {};
  return {
    put(key: string, body: Buffer): Promise<void> {
      objects[key] = body;
      return Promise.resolve();
    },
    get(key: string): Promise<Buffer> {
      return objects[key] ? Promise.resolve(objects[key]) : Promise.reject(new Error(`missing ${key}`));
    },
  };
}

/** runUI stub: one viewport with a critical `load` signal toggled by `loadOk`, plus a passing warning. */
function loadRunUI(loadOk: () => boolean): RunUI {
  return (config) =>
    Promise.resolve({
      signals: config.viewports.map((v) => ({
        viewport: v.label,
        signals: [
          { kind: "load", pass: loadOk(), severity: "critical", detail: loadOk() ? "HTTP 200" : "HTTP 500" },
          { kind: "console", pass: true, severity: "warning", detail: "no console errors" },
        ] as never,
      })),
      diffs: [],
      artifacts: config.viewports.map((v) => ({
        viewport: v.label,
        screenshot: Buffer.from(`png-${v.label}`),
        dims: { w: v.width, h: v.height },
      })),
    });
}

let repo: ConfigRepo;

beforeEach(() => {
  repo = createConfigRepo(new InMemoryConfigStore());
});

async function seedUICheck(over: Partial<UICheckInput> = {}): Promise<{ checkId: string; projectId: string }> {
  const project = await repo.createProject({ name: "Acme", alertEmails: ["ops@acme.test"] }, actor);
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  const check = await repo.createUICheck({ siteId: site.id, path: "/pricing", viewports: ["desktop"], ...over }, actor);
  return { checkId: check.id, projectId: project.id };
}

const noopEnqueue = (): Promise<void> => Promise.resolve();

// ---- scheduling (AC #1, #4) ----

test("a UI check is enqueued once per day by default (AC #1)", async () => {
  const clock = controllableClock(0);
  const { checkId } = await seedUICheck();
  const enqueuedUI: string[] = [];
  const enqueueUI = (job: ScheduledJob): Promise<void> => {
    enqueuedUI.push(job.checkId);
    return Promise.resolve();
  };

  await runTick({ now: clock.now, repo, enqueue: noopEnqueue, enqueueUI }); // never run → due
  expect(enqueuedUI).toEqual([checkId]);

  // Record a run so the cadence has an anchor, then assert it isn't due again until a day passes.
  await runUIJob(checkId, { repo, store: fakeStore(), runUI: loadRunUI(() => true), now: clock.now, genId: () => "r0" });
  enqueuedUI.length = 0;

  clock.advance(DAY - 60);
  await runTick({ now: clock.now, repo, enqueue: noopEnqueue, enqueueUI }); // < 1 day → not due
  expect(enqueuedUI).toEqual([]);

  clock.advance(60);
  await runTick({ now: clock.now, repo, enqueue: noopEnqueue, enqueueUI }); // 1 day elapsed → due
  expect(enqueuedUI).toEqual([checkId]);
});

test("a per-check interval override is honored (AC #4)", async () => {
  const clock = controllableClock(0);
  const { checkId } = await seedUICheck({ intervalSeconds: 3600 }); // hourly, not daily
  const enqueuedUI: string[] = [];
  const enqueueUI = (job: ScheduledJob): Promise<void> => {
    enqueuedUI.push(job.checkId);
    return Promise.resolve();
  };

  await runTick({ now: clock.now, repo, enqueue: noopEnqueue, enqueueUI });
  await runUIJob(checkId, { repo, store: fakeStore(), runUI: loadRunUI(() => true), now: clock.now, genId: () => "r0" });
  enqueuedUI.length = 0;

  clock.advance(3600);
  await runTick({ now: clock.now, repo, enqueue: noopEnqueue, enqueueUI });
  expect(enqueuedUI).toEqual([checkId]); // due after 1h, far sooner than the daily default
});

test("a tick with no UI enqueue wired skips UI scheduling entirely (heartbeat-only)", async () => {
  const clock = controllableClock(0);
  await seedUICheck();
  const result = await runTick({ now: clock.now, repo, enqueue: noopEnqueue }); // no enqueueUI
  expect(result.ui).toEqual([]);
});

// ---- AC #5 end-to-end: schedule → run → incident → alert → recovery ----

test("end-to-end: load=critical failure opens an incident + alerts, recovering after 2 daily successes", async () => {
  const clock = controllableClock(0);
  const { checkId, projectId } = await seedUICheck();
  const events: IncidentAlertEvent[] = [];
  const alerter = (e: IncidentAlertEvent): Promise<void> => {
    events.push(e);
    return Promise.resolve();
  };
  const store = fakeStore();
  let loadOk = false; // start pointed at a 500

  // The UI enqueue runs the job inline with the alerter — the synchronous
  // in-memory queue, mirroring how index.ts wires runUIJob.
  let runSeq = 0;
  const enqueueUI = async (): Promise<void> => {
    await runUIJob(checkId, {
      repo,
      store,
      runUI: loadRunUI(() => loadOk),
      now: clock.now,
      genId: () => `run-${runSeq++}`,
      alerter,
    });
  };
  const tick = (): Promise<unknown> => runTick({ now: clock.now, repo, enqueue: noopEnqueue, enqueueUI });

  // Day 0 — broken: tick enqueues, job runs, load(critical) fails → incident opens + realtime alert.
  await tick();
  const opened = await repo.getOpenIncident(checkId);
  expect(opened).not.toBeNull();
  expect(opened!.openedAt).toEqual(new Date(0));
  expect(events.map((e) => e.kind)).toEqual(["opened"]);
  expect(events[0]!.checkType).toBe("uicheck");
  expect(events[0]!.checkLabel).toBe("acme.test/pricing");
  expect(events[0]!.error).toContain("load: HTTP 500");

  // Restore the URL.
  loadOk = true;

  // Day 1 — one success: not enough to close.
  clock.advance(DAY);
  await tick();
  expect(await repo.getOpenIncident(checkId)).not.toBeNull();
  expect(events.some((e) => e.kind === "recovered")).toBe(false);

  // Day 2 — second consecutive success: incident closes with duration + recovery alert.
  clock.advance(DAY);
  await tick();
  expect(await repo.getOpenIncident(checkId)).toBeNull();

  const recovered = events.find((e) => e.kind === "recovered");
  expect(recovered).toBeDefined();
  expect(recovered!.checkType).toBe("uicheck");
  expect(recovered!.durationMs).toBe(2 * DAY * 1000); // ≈48h — the documented daily-cadence lag

  const closed = (await repo.listProjectIncidents(projectId)).find((i) => i.closedAt !== null);
  expect(closed).toBeDefined();
  expect(closed!.closedAt).toEqual(new Date(2 * DAY * 1000));
});

test("a warning-only UI failure does not open an incident or alert", async () => {
  const clock = controllableClock(0);
  const { checkId } = await seedUICheck();
  const events: IncidentAlertEvent[] = [];
  const alerter = (e: IncidentAlertEvent): Promise<void> => {
    events.push(e);
    return Promise.resolve();
  };
  // load passes (critical), console fails (warning) → run status=fail, but no critical fail.
  const warnRunUI: RunUI = (config) =>
    Promise.resolve({
      signals: config.viewports.map((v) => ({
        viewport: v.label,
        signals: [
          { kind: "load", pass: true, severity: "critical", detail: "HTTP 200" },
          { kind: "console", pass: false, severity: "warning", detail: "1 console error: boom" },
        ] as never,
      })),
      diffs: [],
      artifacts: config.viewports.map((v) => ({
        viewport: v.label,
        screenshot: Buffer.from(`png-${v.label}`),
        dims: { w: v.width, h: v.height },
      })),
    });

  const run = await runUIJob(checkId, { repo, store: fakeStore(), runUI: warnRunUI, now: clock.now, genId: () => "r0", alerter });

  expect(run!.status).toBe("fail"); // any signal fails the run (digest)
  expect(run!.criticalFailed).toBe(false); // but no critical signal → no page
  expect(await repo.getOpenIncident(checkId)).toBeNull();
  expect(events).toEqual([]);
});
