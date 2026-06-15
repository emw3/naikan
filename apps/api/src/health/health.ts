/**
 * Pure self-monitoring assessment for `/health` (#18).
 *
 * Two assertions decide whether the platform is monitoring itself:
 *
 *   1. Queue lag        — the oldest graphile-worker job still waiting to run is
 *                         younger than `queueLagSeconds`. A stalled worker lets
 *                         jobs age past this.
 *   2. Last-run freshness — a CheckRun exists across all checks within
 *                         `freshnessMultiplier × (shortest configured heartbeat
 *                         interval)`. A dead worker stops producing runs.
 *
 * This module is pure: it takes already-gathered signals and a clock and returns
 * a verdict. Probing the queue / DB lives behind the `HealthProbe` seam (routes.ts),
 * so the verdict logic is unit-tested without a database.
 */

export interface HealthThresholds {
  /** Max age (seconds) of the oldest waiting queue job before the queue is "lagging". */
  queueLagSeconds: number;
  /** Freshness window = this × the shortest configured heartbeat interval. */
  freshnessMultiplier: number;
}

export interface HealthSignals {
  /** Age (ms) of the oldest queue job still waiting to run, or null if none wait. */
  oldestWaitingJobAgeMs: number | null;
  /** When the newest CheckRun across all checks finished, or null if none exist. */
  latestRunAt: Date | null;
  /** Shortest configured heartbeat interval (seconds), or null if no checks exist. */
  shortestIntervalSeconds: number | null;
}

/** One assertion's verdict plus a human-readable reason (surfaced in the 503 body). */
export interface AssertionResult {
  ok: boolean;
  detail: string;
}

export interface HealthReport {
  healthy: boolean;
  checks: {
    queueLag: AssertionResult;
    lastRunFreshness: AssertionResult;
  };
}

function assessQueueLag(ageMs: number | null, thresholdSeconds: number): AssertionResult {
  if (ageMs === null) {
    return { ok: true, detail: "no jobs waiting in the queue" };
  }
  const ageSeconds = Math.round(ageMs / 1000);
  const ok = ageMs <= thresholdSeconds * 1000;
  return {
    ok,
    detail: ok
      ? `oldest waiting job is ${ageSeconds}s old (threshold ${thresholdSeconds}s)`
      : `oldest waiting job is ${ageSeconds}s old, exceeding the ${thresholdSeconds}s queue-lag threshold`,
  };
}

function assessFreshness(
  latestRunAt: Date | null,
  shortestIntervalSeconds: number | null,
  multiplier: number,
  now: Date,
): AssertionResult {
  if (shortestIntervalSeconds === null) {
    return { ok: true, detail: "no heartbeat checks configured" };
  }
  const windowSeconds = multiplier * shortestIntervalSeconds;
  if (latestRunAt === null) {
    return {
      ok: false,
      detail: `no check run recorded yet (freshness window ${windowSeconds}s)`,
    };
  }
  const ageMs = now.getTime() - latestRunAt.getTime();
  const ageSeconds = Math.round(ageMs / 1000);
  const ok = ageMs <= windowSeconds * 1000;
  return {
    ok,
    detail: ok
      ? `last run was ${ageSeconds}s ago (freshness window ${windowSeconds}s)`
      : `last run was ${ageSeconds}s ago, exceeding the ${windowSeconds}s freshness window`,
  };
}

/** Decide platform health from gathered signals. Returns 200-worthy iff `healthy`. */
export function assessHealth(
  signals: HealthSignals,
  thresholds: HealthThresholds,
  now: Date,
): HealthReport {
  const queueLag = assessQueueLag(signals.oldestWaitingJobAgeMs, thresholds.queueLagSeconds);
  const lastRunFreshness = assessFreshness(
    signals.latestRunAt,
    signals.shortestIntervalSeconds,
    thresholds.freshnessMultiplier,
    now,
  );
  return {
    healthy: queueLag.ok && lastRunFreshness.ok,
    checks: { queueLag, lastRunFreshness },
  };
}
