import type { ScheduleEntry, ScheduledJob } from "./types.ts";

/**
 * Pure scheduling decision: given the current time and each check's interval and
 * last-run time, return one job per check that is due to run now.
 *
 * A check is due when it has never run (`lastRunAt === null`), or when at least
 * `intervalSeconds` have elapsed since its last run started. A long-overdue
 * check (the scheduler was down, ticks were missed) yields exactly one job —
 * missed slots are not back-filled; the next tick simply catches it up. A
 * `lastRunAt` in the future (clock skew) is treated as not due.
 *
 * No clock or database is read here: `now` and the entries are passed in, so the
 * decision is deterministic and unit-testable. Entry order is preserved.
 */
export function nextRunsFor(now: Date, entries: ScheduleEntry[]): ScheduledJob[] {
  return entries.filter((e) => isDue(now, e)).map((e) => ({ checkId: e.checkId }));
}

function isDue(now: Date, entry: ScheduleEntry): boolean {
  if (entry.lastRunAt === null) return true;
  const elapsedMs = now.getTime() - entry.lastRunAt.getTime();
  return elapsedMs >= entry.intervalSeconds * 1000;
}
