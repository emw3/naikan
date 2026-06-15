/**
 * Scheduler tick — the periodic "what should run now?" pass.
 *
 * One tick gathers each check's *effective* interval (CheckGroup inheritance
 * resolved by config-repo) and last-run time, asks the *pure*
 * `@naikan/scheduler` which checks are due, and enqueues a run job for each. It
 * does this for both check families: heartbeat checks (fast, #07) and UI checks
 * (daily, #14). The scheduling decision lives entirely in the scheduler; this
 * function only does the I/O around it (read config + runs, enqueue). The clock
 * and repo are injected so a tick is deterministic in tests.
 *
 * `lastRunAt` is derived from the most recent CheckRun's `startedAt` — the
 * cadence anchors on when a run began. (One `listRuns` per check; fine at MVP
 * scale, revisit with a bulk "last run per check" query if check counts grow.)
 */
import { nextRunsFor, type ScheduleEntry, type ScheduledJob } from "@naikan/scheduler";
import type { ConfigRepo } from "@naikan/config-repo";

/** Enqueues a run job for one due check. */
export type Enqueue = (job: ScheduledJob) => Promise<void>;

export interface TickDeps {
  /** Current time, injected for deterministic scheduling. */
  now: () => Date;
  repo: ConfigRepo;
  /** Enqueue a `heartbeat-run` job for a due heartbeat check (#07). */
  enqueue: Enqueue;
  /**
   * Enqueue a `uicheck-run` job for a due UI check (#14). Optional: omit it (e.g.
   * a heartbeat-only test or worker) to skip UI scheduling entirely.
   */
  enqueueUI?: Enqueue;
}

/** What a tick enqueued, split by check family. */
export interface TickResult {
  heartbeat: ScheduledJob[];
  ui: ScheduledJob[];
}

/** Run one tick: enqueue a job for every heartbeat + UI check the scheduler deems due. */
export async function runTick(deps: TickDeps): Promise<TickResult> {
  const { now, repo, enqueue, enqueueUI } = deps;
  const at = now();

  const checks = await repo.listEffectiveChecks();
  const entries: ScheduleEntry[] = await Promise.all(
    checks.map(async (check) => {
      const [latest] = await repo.listRuns(check.id, 1);
      return {
        checkId: check.id,
        intervalSeconds: check.intervalSeconds, // resolved (never null) by config-repo
        lastRunAt: latest?.startedAt ?? null,
      };
    }),
  );
  const heartbeat = nextRunsFor(at, entries);
  for (const job of heartbeat) await enqueue(job);

  // UI checks run on their own (daily) cadence through the same pure scheduler.
  let ui: ScheduledJob[] = [];
  if (enqueueUI) {
    const uichecks = await repo.listEffectiveUIChecks();
    const uiEntries: ScheduleEntry[] = await Promise.all(
      uichecks.map(async (check) => {
        const [latest] = await repo.listRuns(check.id, 1);
        return {
          checkId: check.id,
          intervalSeconds: check.intervalSeconds, // resolved (never null) by config-repo
          lastRunAt: latest?.startedAt ?? null,
        };
      }),
    );
    ui = nextRunsFor(at, uiEntries);
    for (const job of ui) await enqueueUI(job);
  }

  return { heartbeat, ui };
}
