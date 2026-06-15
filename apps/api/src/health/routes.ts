/**
 * HTTP surface for self-monitoring `/health` (#18), mounted at the root and
 * **unauthenticated** so an external uptime service (UptimeRobot) can poll it.
 *
 * The route gathers three signals behind the `HealthProbe` seam, runs the pure
 * `assessHealth` verdict, and returns 200 when healthy or 503 (with a body naming
 * the failed assertion) otherwise. A probe failure (e.g. the DB is unreachable)
 * also returns 503 rather than crashing — `/health` must always respond (#01).
 */
import { Hono } from "hono";
import postgres from "postgres";
import type { ConfigRepo } from "@naikan/config-repo";
import { assessHealth, type HealthSignals, type HealthThresholds } from "./health.ts";

/** The signals `/health` needs, each gathered independently so they can run in parallel. */
export interface HealthProbe {
  /** Age (ms) of the oldest queue job still waiting to run, or null if none wait. */
  oldestWaitingJobAgeMs(): Promise<number | null>;
  /** The newest CheckRun timestamp across all checks, or null if none exist. */
  latestRunAt(): Promise<Date | null>;
  /** The shortest configured (effective) heartbeat interval in seconds, or null. */
  shortestIntervalSeconds(): Promise<number | null>;
}

export interface HealthAppOptions {
  probe: HealthProbe;
  thresholds: HealthThresholds;
  /** Clock, injectable for deterministic tests. */
  now?: () => Date;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createHealthApp(opts: HealthAppOptions) {
  const now = opts.now ?? (() => new Date());
  const app = new Hono();

  app.get("/health", async (c) => {
    let signals: HealthSignals;
    try {
      const [oldestWaitingJobAgeMs, latestRunAt, shortestIntervalSeconds] = await Promise.all([
        opts.probe.oldestWaitingJobAgeMs(),
        opts.probe.latestRunAt(),
        opts.probe.shortestIntervalSeconds(),
      ]);
      signals = { oldestWaitingJobAgeMs, latestRunAt, shortestIntervalSeconds };
    } catch (err) {
      return c.json(
        { status: "unhealthy", error: "health probe failed", detail: errorMessage(err) },
        503,
      );
    }

    const report = assessHealth(signals, opts.thresholds, now());
    return c.json(
      { status: report.healthy ? "ok" : "unhealthy", checks: report.checks },
      report.healthy ? 200 : 503,
    );
  });

  return app;
}

// ---- production probe (Postgres + config-repo) ----

export interface PgHealthProbeOptions {
  /**
   * Lazy accessor for the shared `postgres` project — used directly only for the
   * graphile-worker queue. A thunk (like `createPgConfigStore`) keeps boot DB-free.
   */
  getSql: () => ReturnType<typeof postgres>;
  repo: ConfigRepo;
  /**
   * Whether a database is configured at all. When false the probe reports the
   * empty no-DB state (no queue, no checks → nothing to monitor → healthy) without
   * touching the DB, preserving the no-DB boot (#01, exercised by the smoke test).
   * Defaults to "configured" — index.ts wires it to the DATABASE_URL check.
   */
  databaseConfigured?: () => boolean;
  /** TTL (ms) for caching the queue-lag query; default 10s (keeps `/health` < 500ms). */
  queueLagCacheMs?: number;
  /** Clock, injectable for deterministic tests of the cache. */
  now?: () => Date;
}

/** PostgreSQL error codes for "the graphile_worker schema/view isn't there yet". */
const MISSING_RELATION_CODES = new Set(["42P01", "3F000"]); // undefined_table, invalid_schema_name

/**
 * The live probe. Queue lag reads graphile-worker's `graphile_worker.jobs` view
 * (its documented-stable surface over the private job tables) for the oldest job
 * that is runnable now but unlocked — i.e. waiting on a worker. If the schema
 * isn't installed yet (worker never booted), there are no waiting jobs to measure,
 * so we report null and let the freshness assertion carry the "is anything running"
 * signal. Last-run + shortest-interval come through the config-repo (the single
 * DB-access path for check entities).
 */
export function createPgHealthProbe(opts: PgHealthProbeOptions): HealthProbe {
  const { getSql, repo } = opts;
  const now = opts.now ?? (() => new Date());
  const databaseConfigured = opts.databaseConfigured ?? (() => true);
  const cacheTtlMs = opts.queueLagCacheMs ?? 10_000;
  let cache: { atMs: number; value: number | null } | undefined;

  async function queryQueueLag(): Promise<number | null> {
    try {
      const sql = getSql();
      const rows = await sql<{ lag_seconds: number | null }[]>`
        select extract(epoch from (now() - run_at)) as lag_seconds
        from graphile_worker.jobs
        where locked_at is null and run_at <= now()
        order by run_at asc
        limit 1`;
      const lagSeconds = rows[0]?.lag_seconds;
      return lagSeconds == null ? null : Math.round(Number(lagSeconds) * 1000);
    } catch (err) {
      // Schema/view not installed yet → no measurable queue. Connection-level
      // failures carry a different code and propagate, surfacing as a 503.
      const code = (err as { code?: string }).code;
      if (code && MISSING_RELATION_CODES.has(code)) return null;
      throw err;
    }
  }

  return {
    async oldestWaitingJobAgeMs() {
      if (!databaseConfigured()) return null;
      const t = now().getTime();
      if (cache && t - cache.atMs < cacheTtlMs) return cache.value;
      const value = await queryQueueLag();
      cache = { atMs: t, value };
      return value;
    },
    latestRunAt: () => (databaseConfigured() ? repo.latestRunAt() : Promise.resolve(null)),
    async shortestIntervalSeconds() {
      if (!databaseConfigured()) return null;
      const checks = await repo.listEffectiveChecks();
      if (checks.length === 0) return null;
      return Math.min(...checks.map((c) => c.intervalSeconds));
    },
  };
}

/** Read `/health` thresholds from env, falling back to the PRD defaults. */
export function thresholdsFromEnv(env: Record<string, string | undefined> = process.env): HealthThresholds {
  const queueLagSeconds = Number(env.HEALTH_QUEUE_LAG_SECONDS);
  const freshnessMultiplier = Number(env.HEALTH_FRESHNESS_MULTIPLIER);
  return {
    queueLagSeconds: Number.isFinite(queueLagSeconds) && queueLagSeconds > 0 ? queueLagSeconds : 300,
    freshnessMultiplier:
      Number.isFinite(freshnessMultiplier) && freshnessMultiplier > 0 ? freshnessMultiplier : 2,
  };
}
