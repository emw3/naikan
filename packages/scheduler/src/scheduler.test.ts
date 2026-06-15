import { expect, test } from "bun:test";
import { nextRunsFor } from "./scheduler.ts";
import type { ScheduleEntry } from "./types.ts";

/** Epoch + the given number of seconds, as a Date. */
const at = (seconds: number): Date => new Date(seconds * 1000);

const entry = (over: Partial<ScheduleEntry> & { checkId: string }): ScheduleEntry => ({
  intervalSeconds: 60,
  lastRunAt: null,
  ...over,
});

// ---- simple intervals ----

test("a check that has never run is due", () => {
  const jobs = nextRunsFor(at(0), [entry({ checkId: "a", lastRunAt: null })]);
  expect(jobs).toEqual([{ checkId: "a" }]);
});

test("a check is not due before its interval has elapsed", () => {
  const jobs = nextRunsFor(at(59), [entry({ checkId: "a", intervalSeconds: 60, lastRunAt: at(0) })]);
  expect(jobs).toEqual([]);
});

test("a check is due exactly at the interval boundary", () => {
  const jobs = nextRunsFor(at(60), [entry({ checkId: "a", intervalSeconds: 60, lastRunAt: at(0) })]);
  expect(jobs).toEqual([{ checkId: "a" }]);
});

test("a check is due once its interval has elapsed", () => {
  const jobs = nextRunsFor(at(125), [entry({ checkId: "a", intervalSeconds: 60, lastRunAt: at(0) })]);
  expect(jobs).toEqual([{ checkId: "a" }]);
});

// ---- missed-tick catch-up ----

test("a long-overdue check is due exactly once (missed ticks are not back-filled)", () => {
  // Last ran at t=0, interval 60s, now t=3600 → 60 missed slots, but one job.
  const jobs = nextRunsFor(at(3600), [entry({ checkId: "a", intervalSeconds: 60, lastRunAt: at(0) })]);
  expect(jobs).toEqual([{ checkId: "a" }]);
});

// ---- multiple checks with different intervals ----

test("returns only the due checks among many with different intervals", () => {
  const now = at(100);
  const jobs = nextRunsFor(now, [
    entry({ checkId: "due-never", lastRunAt: null }), // never ran → due
    entry({ checkId: "due-30s", intervalSeconds: 30, lastRunAt: at(60) }), // 40s elapsed ≥ 30 → due
    entry({ checkId: "not-due-300s", intervalSeconds: 300, lastRunAt: at(0) }), // 100s elapsed < 300 → not due
    entry({ checkId: "not-due-60s", intervalSeconds: 60, lastRunAt: at(50) }), // 50s elapsed < 60 → not due
  ]);
  expect(jobs).toEqual([{ checkId: "due-never" }, { checkId: "due-30s" }]);
});

// ---- edge cases ----

test("no entries yields no jobs", () => {
  expect(nextRunsFor(at(100), [])).toEqual([]);
});

test("a future lastRunAt (clock skew) is treated as not due", () => {
  const jobs = nextRunsFor(at(0), [entry({ checkId: "a", intervalSeconds: 60, lastRunAt: at(100) })]);
  expect(jobs).toEqual([]);
});
