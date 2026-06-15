import { expect, test } from "bun:test";
import { assessHealth, type HealthSignals, type HealthThresholds } from "./health.ts";

const THRESHOLDS: HealthThresholds = { queueLagSeconds: 300, freshnessMultiplier: 2 };
const NOW = new Date(10_000_000);

/** A platform that passes both assertions by default; override one field per test. */
function signals(over: Partial<HealthSignals> = {}): HealthSignals {
  return {
    oldestWaitingJobAgeMs: 30_000, // 30s — well under the 300s lag threshold
    latestRunAt: new Date(NOW.getTime() - 60_000), // 60s ago — fresh
    shortestIntervalSeconds: 300, // 5min → 600s freshness window
    ...over,
  };
}

test("healthy when the queue is current and a recent run exists", () => {
  const report = assessHealth(signals(), THRESHOLDS, NOW);
  expect(report.healthy).toBe(true);
  expect(report.checks.queueLag.ok).toBe(true);
  expect(report.checks.lastRunFreshness.ok).toBe(true);
});

test("unhealthy when the oldest waiting job is older than the lag threshold", () => {
  const report = assessHealth(signals({ oldestWaitingJobAgeMs: 301_000 }), THRESHOLDS, NOW);
  expect(report.healthy).toBe(false);
  expect(report.checks.queueLag.ok).toBe(false);
  expect(report.checks.lastRunFreshness.ok).toBe(true); // only queue lag failed
});

test("queue lag exactly at the threshold still passes (inclusive boundary)", () => {
  const report = assessHealth(signals({ oldestWaitingJobAgeMs: 300_000 }), THRESHOLDS, NOW);
  expect(report.checks.queueLag.ok).toBe(true);
});

test("an empty queue (no waiting jobs) passes the lag assertion", () => {
  const report = assessHealth(signals({ oldestWaitingJobAgeMs: null }), THRESHOLDS, NOW);
  expect(report.checks.queueLag.ok).toBe(true);
});

test("unhealthy when the last run is older than freshnessMultiplier × shortest interval", () => {
  // window = 2 × 300s = 600s; a run 601s ago is stale.
  const report = assessHealth(
    signals({ latestRunAt: new Date(NOW.getTime() - 601_000) }),
    THRESHOLDS,
    NOW,
  );
  expect(report.healthy).toBe(false);
  expect(report.checks.lastRunFreshness.ok).toBe(false);
  expect(report.checks.queueLag.ok).toBe(true); // only freshness failed
});

test("last run exactly at the freshness window still passes (inclusive boundary)", () => {
  const report = assessHealth(
    signals({ latestRunAt: new Date(NOW.getTime() - 600_000) }),
    THRESHOLDS,
    NOW,
  );
  expect(report.checks.lastRunFreshness.ok).toBe(true);
});

test("freshness is vacuously ok when no heartbeat checks are configured", () => {
  const report = assessHealth(
    signals({ shortestIntervalSeconds: null, latestRunAt: null }),
    THRESHOLDS,
    NOW,
  );
  expect(report.healthy).toBe(true);
  expect(report.checks.lastRunFreshness.ok).toBe(true);
});

test("freshness fails when checks are configured but no run has ever been recorded", () => {
  const report = assessHealth(signals({ latestRunAt: null }), THRESHOLDS, NOW);
  expect(report.checks.lastRunFreshness.ok).toBe(false);
});

test("a failed assertion names itself in its detail", () => {
  const report = assessHealth(signals({ oldestWaitingJobAgeMs: 400_000 }), THRESHOLDS, NOW);
  expect(report.checks.queueLag.detail.length).toBeGreaterThan(0);
});
