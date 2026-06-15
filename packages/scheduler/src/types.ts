/**
 * Types for `@naikan/scheduler` — the pure decision module that turns each
 * check's interval + last-run time into the set of checks due to run now.
 *
 * The scheduler reads no clock and no database: the current time and every
 * check's `lastRunAt` are passed in (see `nextRunsFor`), so the decision is
 * deterministic and unit-testable. The tick process (apps/worker) gathers these
 * entries from `config-repo` and enqueues a job per returned `ScheduledJob`.
 */

/** One check's scheduling state. */
export interface ScheduleEntry {
  /** The HeartbeatCheck this entry schedules. */
  checkId: string;
  /** How often the check should run, in seconds (always positive). */
  intervalSeconds: number;
  /** When the check last *started* a run, or null if it has never run. */
  lastRunAt: Date | null;
}

/** A scheduler decision: this check is due and should be enqueued now. */
export interface ScheduledJob {
  checkId: string;
}
