import { expect, test } from "bun:test";
import {
  createHealthApp,
  createPgHealthProbe,
  thresholdsFromEnv,
  type HealthProbe,
} from "./routes.ts";
import type { ConfigRepo } from "@naikan/config-repo";
import type { HealthThresholds } from "./health.ts";

const THRESHOLDS: HealthThresholds = { queueLagSeconds: 300, freshnessMultiplier: 2 };

/**
 * A controllable clock + fake probe modelling the worker's effect on the platform.
 * The issue's end-to-end demo — "stop the worker → /health flips to 503; restart →
 * back to 200" — is reproduced here at the probe seam: a stalled worker stops
 * draining the queue (its oldest job ages) and stops recording runs (the clock
 * advances past the freshness window). This mirrors worker.test.ts, which exercises
 * the scheduling path with the real graphile-worker transport deliberately stubbed.
 */
function harness() {
  let nowMs = 1_000_000;
  const state = {
    oldestWaitingJobAgeMs: 0 as number | null,
    latestRunAt: new Date(nowMs) as Date | null,
    shortestIntervalSeconds: 300 as number | null,
    failProbe: false,
  };
  const guard = <T>(value: T): Promise<T> =>
    state.failProbe ? Promise.reject(new Error("database unreachable")) : Promise.resolve(value);
  const probe: HealthProbe = {
    oldestWaitingJobAgeMs: () => guard(state.oldestWaitingJobAgeMs),
    latestRunAt: () => guard(state.latestRunAt),
    shortestIntervalSeconds: () => guard(state.shortestIntervalSeconds),
  };
  const app = createHealthApp({ probe, thresholds: THRESHOLDS, now: () => new Date(nowMs) });
  return {
    state,
    advance: (seconds: number) => {
      nowMs += seconds * 1000;
    },
    get: () => app.request("/health"),
  };
}

test("returns 200 OK while the worker is running", async () => {
  const h = harness();
  const res = await h.get();
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ status: "ok" });
});

test("queue lag past the threshold flips /health to 503", async () => {
  const h = harness();
  h.state.oldestWaitingJobAgeMs = 301_000; // worker stalled; oldest job aged past 300s
  const res = await h.get();
  expect(res.status).toBe(503);
  const body = await res.json();
  expect(body.status).toBe("unhealthy");
  expect(body.checks.queueLag.ok).toBe(false);
});

test("stale runs flip /health to 503 within the freshness window", async () => {
  const h = harness();
  h.advance(601); // no fresh run for >2×300s
  const res = await h.get();
  expect(res.status).toBe(503);
  const body = await res.json();
  expect(body.checks.lastRunFreshness.ok).toBe(false);
});

test("the 503 body names the failed assertion", async () => {
  const h = harness();
  h.advance(601);
  const body = await (await h.get()).json();
  expect(body.checks.lastRunFreshness.detail).toContain("freshness window");
});

test("recovers to 200 once the queue drains and a fresh run lands (worker restart)", async () => {
  const h = harness();
  // Worker down: queue backed up and runs gone stale.
  h.state.oldestWaitingJobAgeMs = 600_000;
  h.advance(601);
  expect((await h.get()).status).toBe(503);

  // Worker restarts: it drains the backlog and records a fresh run.
  h.state.oldestWaitingJobAgeMs = null;
  h.state.latestRunAt = new Date(1_000_000 + 601_000);
  const res = await h.get();
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ status: "ok" });
});

test("returns 503 (not a crash) when a probe fails, e.g. the DB is unreachable", async () => {
  const h = harness();
  h.state.failProbe = true;
  const res = await h.get();
  expect(res.status).toBe(503);
  expect((await res.json()).status).toBe("unhealthy");
});

test("the endpoint is unauthenticated (no cookie required)", async () => {
  const h = harness();
  // No Authorization / Cookie header is sent by harness.get(); a 200 proves it.
  expect((await h.get()).status).toBe(200);
});

// ---- createPgHealthProbe: queue-lag query, cache, and missing-schema fallback ----

/**
 * A fake `postgres` tagged-template that records call count and yields a scripted
 * result (or throws). `createPgHealthProbe` only ever uses `sql` for the queue-lag
 * query, so this stands in for the real project in queue-lag tests.
 */
function fakeSql(handler: () => unknown[]) {
  let calls = 0;
  const sql = () => {
    calls++;
    return Promise.resolve(handler());
  };
  return { sql, callCount: () => calls };
}

const NO_RUNS_REPO = {
  latestRunAt: () => Promise.resolve(null),
  listEffectiveChecks: () => Promise.resolve([]),
} as unknown as ConfigRepo;

test("queue-lag query converts the oldest waiting job's age from seconds to ms", async () => {
  const { sql } = fakeSql(() => [{ lag_seconds: 42 }]);
  const probe = createPgHealthProbe({ getSql: () => sql as never, repo: NO_RUNS_REPO });
  expect(await probe.oldestWaitingJobAgeMs()).toBe(42_000);
});

test("an empty queue yields null (no waiting job to measure)", async () => {
  const { sql } = fakeSql(() => []);
  const probe = createPgHealthProbe({ getSql: () => sql as never, repo: NO_RUNS_REPO });
  expect(await probe.oldestWaitingJobAgeMs()).toBeNull();
});

test("a missing graphile_worker schema is treated as no waiting jobs, not a crash", async () => {
  const { sql } = fakeSql(() => {
    throw Object.assign(new Error('schema "graphile_worker" does not exist'), { code: "3F000" });
  });
  const probe = createPgHealthProbe({ getSql: () => sql as never, repo: NO_RUNS_REPO });
  expect(await probe.oldestWaitingJobAgeMs()).toBeNull();
});

test("a connection-level query error propagates (so /health reports 503)", async () => {
  const { sql } = fakeSql(() => {
    throw Object.assign(new Error("connection refused"), { code: "08006" });
  });
  const probe = createPgHealthProbe({ getSql: () => sql as never, repo: NO_RUNS_REPO });
  expect(probe.oldestWaitingJobAgeMs()).rejects.toThrow("connection refused");
});

test("the queue-lag query is cached within the TTL and re-runs after it", async () => {
  let nowMs = 0;
  const { sql, callCount } = fakeSql(() => [{ lag_seconds: 1 }]);
  const probe = createPgHealthProbe({
    getSql: () => sql as never,
    repo: NO_RUNS_REPO,
    queueLagCacheMs: 10_000,
    now: () => new Date(nowMs),
  });

  await probe.oldestWaitingJobAgeMs();
  await probe.oldestWaitingJobAgeMs();
  expect(callCount()).toBe(1); // second call served from cache

  nowMs += 10_001; // past the TTL
  await probe.oldestWaitingJobAgeMs();
  expect(callCount()).toBe(2);
});

test("reports the empty no-DB state (and never queries) when no database is configured", async () => {
  // Mirrors the no-DB smoke boot (#01): API up, DATABASE_URL unset. Nothing to
  // monitor → all signals null → assessHealth is vacuously healthy → /health 200.
  const probe = createPgHealthProbe({
    getSql: () => {
      throw new Error("should not query the DB when none is configured");
    },
    repo: {
      latestRunAt: () => Promise.reject(new Error("should not query")),
      listEffectiveChecks: () => Promise.reject(new Error("should not query")),
    } as unknown as ConfigRepo,
    databaseConfigured: () => false,
  });
  expect(await probe.oldestWaitingJobAgeMs()).toBeNull();
  expect(await probe.latestRunAt()).toBeNull();
  expect(await probe.shortestIntervalSeconds()).toBeNull();
});

test("shortestIntervalSeconds is the min effective interval, or null when no checks", async () => {
  const withChecks = {
    latestRunAt: () => Promise.resolve(null),
    listEffectiveChecks: () =>
      Promise.resolve([{ intervalSeconds: 600 }, { intervalSeconds: 120 }, { intervalSeconds: 300 }]),
  } as unknown as ConfigRepo;
  const probe = createPgHealthProbe({ getSql: () => (() => Promise.resolve([])) as never, repo: withChecks });
  expect(await probe.shortestIntervalSeconds()).toBe(120);

  const probeNoChecks = createPgHealthProbe({
    getSql: () => (() => Promise.resolve([])) as never,
    repo: NO_RUNS_REPO,
  });
  expect(await probeNoChecks.shortestIntervalSeconds()).toBeNull();
});

// ---- thresholdsFromEnv ----

test("thresholdsFromEnv reads overrides and falls back to PRD defaults", () => {
  expect(thresholdsFromEnv({})).toEqual({ queueLagSeconds: 300, freshnessMultiplier: 2 });
  expect(
    thresholdsFromEnv({ HEALTH_QUEUE_LAG_SECONDS: "120", HEALTH_FRESHNESS_MULTIPLIER: "3" }),
  ).toEqual({ queueLagSeconds: 120, freshnessMultiplier: 3 });
  // Garbage / non-positive values fall back to the defaults rather than breaking health.
  expect(thresholdsFromEnv({ HEALTH_QUEUE_LAG_SECONDS: "nope", HEALTH_FRESHNESS_MULTIPLIER: "0" })).toEqual({
    queueLagSeconds: 300,
    freshnessMultiplier: 2,
  });
});
