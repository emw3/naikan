/**
 * Worker process entrypoint — runs on **Node** (ADR-0001), separate from the Bun
 * API. Two responsibilities, both over the same Postgres:
 *
 *   1. Consume — graphile-worker runs the `heartbeat-run` task, which invokes
 *      `runHeartbeatJob` (load check + site → run the heartbeat → persist a
 *      CheckRun). No scheduling logic lives in the handler.
 *   2. Schedule — every 30s a tick asks the pure `@naikan/scheduler` which
 *      checks are due and enqueues a `heartbeat-run` job per due check.
 *
 * Run it standalone (independent of the API):
 *
 *   DATABASE_URL=postgres://… node apps/worker/src/index.ts
 *   # or, from the workspace:  bun run --cwd apps/worker start   (which calls node)
 *
 * Node ≥ 22.18 strips TypeScript types natively, so the `.ts` kernel packages
 * import directly with no build step. graphile-worker installs and owns its own
 * `graphile_worker` schema on boot, so the app migrations don't manage the queue.
 */
import { makeWorkerUtils, run, type Task } from "graphile-worker";
import postgres from "postgres";
import { createConfigRepo, createPgConfigStore } from "@naikan/config-repo";
import { createLiveChannels, makeIncidentAlerter, type AlertChannels } from "@naikan/alerter";
import { configFromEnv, createArtifactStore, type ArtifactStore } from "@naikan/baseline-store";
import type { ScheduledJob } from "@naikan/scheduler";
import { runHeartbeatJob } from "./job.ts";
import { runUIJob } from "./ui-job.ts";
import { runTick } from "./tick.ts";
import { runDigestSend } from "./digest-job.ts";
import { runRetentionReaper } from "./reaper-job.ts";

/** How often the scheduler tick runs (PRD: every 30s). */
const TICK_INTERVAL_MS = 30_000;
/** Fast liveness probes (#06) — enqueued by the scheduler tick. */
const HEARTBEAT_TASK = "heartbeat-run";
/** Daily browser-rendered checks (#11) — enqueued by the API's "Run now". */
const UICHECK_TASK = "uicheck-run";
/** Daily per-manager digest (#15) — fired by graphile-worker's cron, not the tick. */
const DIGEST_TASK = "digest-send";
/**
 * When the daily digest fires, as a graphile-worker crontab schedule (UTC). MVP
 * is a single global send time (PRD: default 08:00); per-manager timezones are a
 * v2 concern. Override with `DIGEST_CRON` (standard 5-field cron).
 */
const DIGEST_CRON = process.env.DIGEST_CRON ?? "0 8 * * *";
/** Daily retention reaper (#17) — fired by graphile-worker's cron, not the tick. */
const REAPER_TASK = "retention-reap";
/**
 * When the daily reaper fires, as a graphile-worker crontab schedule (UTC).
 * Defaults to 03:30 — off-peak and offset from the 08:00 digest. Override with
 * `RETENTION_CRON` (standard 5-field cron).
 */
const REAPER_CRON = process.env.RETENTION_CRON ?? "30 3 * * *";
/** Concurrent jobs per worker process; tune for the box. */
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 5);

/** Payload carried on a `heartbeat-run` job — just which check to run. */
interface HeartbeatPayload {
  checkId: string;
}

/** Payload carried on a `uicheck-run` job — just which UI check to run. */
interface UICheckPayload {
  checkId: string;
}

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

/**
 * Build the email + Slack channels (#10) from env, shared by the realtime
 * incident alerter and the daily digest (#15). RESEND_API_KEY + ALERT_FROM_EMAIL
 * enable email; APP_BASE_URL drives the dashboard deep-link (defaults to
 * localhost for dev). Slack routing is per-project (the webhook URL on the
 * Project), so it needs no global env. Missing email config doesn't block boot:
 * a live send just fails best-effort until configured — exercised under #10's
 * human merge gate.
 */
function buildChannels(): { channels: AlertChannels; appBaseUrl: string } {
  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.ALERT_FROM_EMAIL;
  const appBaseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
  if (!resendApiKey || !fromEmail) {
    console.log(
      "worker: email not configured (set RESEND_API_KEY + ALERT_FROM_EMAIL); alerts + digests are Slack-only",
    );
  }
  const channels = createLiveChannels({
    resendApiKey: resendApiKey ?? "",
    fromEmail: fromEmail ?? "",
  });
  return { channels, appBaseUrl };
}

async function main(): Promise<void> {
  const dbUrl = connectionString();

  // config-repo speaks the `postgres` lib (raw SQL, no ORM) on its own pool —
  // lazy, like the API's db.ts. graphile-worker uses node-postgres internally.
  const sql = postgres(dbUrl);
  const repo = createConfigRepo(createPgConfigStore(() => sql));
  const { channels, appBaseUrl } = buildChannels();
  const alerter = makeIncidentAlerter(channels, appBaseUrl);

  // Artifact store for uicheck screenshots + manifests. Built lazily from S3_* env
  // on the first uicheck job so a heartbeat-only / no-S3 worker still boots; a
  // misconfigured store surfaces as a (retried) job failure, not a boot crash.
  let artifactStore: ArtifactStore | undefined;
  const getStore = (): ArtifactStore => {
    if (!artifactStore) artifactStore = createArtifactStore(configFromEnv());
    return artifactStore;
  };

  // ---- consume: the queue invokes the job handlers ----
  const heartbeatRun: Task = async (payload) => {
    const { checkId } = payload as HeartbeatPayload;
    await runHeartbeatJob(checkId, { repo, alerter });
  };
  const uicheckRun: Task = async (payload) => {
    const { checkId } = payload as UICheckPayload;
    // Same alerter as heartbeats: a UI run whose critical signal fails opens an
    // incident and pages realtime; warnings stay in the digest (#14).
    await runUIJob(checkId, { repo, store: getStore(), alerter });
  };
  // Fired daily by the crontab below (payload is the cron metadata — ignored).
  // Builds + dispatches every manager's digest over the last 24h (#15).
  const digestSend: Task = async () => {
    const result = await runDigestSend({ repo, channels, appBaseUrl, now: () => new Date() });
    console.log(
      `digest: ${result.projects} project(s) → ${result.emails} email(s), ${result.slackPosts} Slack post(s)`,
    );
  };
  // Fired daily by the crontab below: deletes aged UI-check artifacts per project
  // and tombstones those runs (#17). Needs the artifact store, so it lazily builds
  // it via the same getStore() the uicheck job uses.
  const retentionReap: Task = async () => {
    const result = await runRetentionReaper({ repo, store: getStore(), now: () => new Date() });
    console.log(
      `reaper: ${result.projects} project(s) → ${result.runsReaped} run(s) reaped, ${result.keysDeleted} object(s) deleted`,
    );
  };

  const runner = await run({
    connectionString: dbUrl,
    concurrency: CONCURRENCY,
    taskList: {
      [HEARTBEAT_TASK]: heartbeatRun,
      [UICHECK_TASK]: uicheckRun,
      [DIGEST_TASK]: digestSend,
      [REAPER_TASK]: retentionReap,
    },
    // graphile-worker's own scheduler fires the cron tasks on their lines (one per
    // line); it persists last-run state so a restart never double-fires or backfills.
    crontab: `${DIGEST_CRON} ${DIGEST_TASK}\n${REAPER_CRON} ${REAPER_TASK}`,
  });
  console.log(
    `worker: consuming "${HEARTBEAT_TASK}" + "${UICHECK_TASK}" + "${DIGEST_TASK}" + "${REAPER_TASK}" jobs (concurrency ${CONCURRENCY}); digest cron "${DIGEST_CRON}", reaper cron "${REAPER_CRON}"`,
  );

  // ---- schedule: enqueue due checks every 30s ----
  const utils = await makeWorkerUtils({ connectionString: dbUrl });
  const enqueue = async (job: ScheduledJob): Promise<void> => {
    await utils.addJob(HEARTBEAT_TASK, { checkId: job.checkId } satisfies HeartbeatPayload, {
      // One pending job per check: a new tick replaces an un-started job rather
      // than stacking duplicates if the worker is slower than the tick.
      jobKey: `heartbeat:${job.checkId}`,
      jobKeyMode: "replace",
    });
  };
  const enqueueUI = async (job: ScheduledJob): Promise<void> => {
    await utils.addJob(UICHECK_TASK, { checkId: job.checkId } satisfies UICheckPayload, {
      // Same single-pending-job-per-check guard as heartbeats; matches the
      // API's "Run now" jobKey so a scheduled run and a manual one coalesce.
      jobKey: `uicheck:${job.checkId}`,
      jobKeyMode: "replace",
    });
  };

  const tick = async (): Promise<void> => {
    try {
      const { heartbeat, ui } = await runTick({ now: () => new Date(), repo, enqueue, enqueueUI });
      if (heartbeat.length) console.log(`tick: enqueued ${heartbeat.length} heartbeat job(s)`);
      if (ui.length) console.log(`tick: enqueued ${ui.length} uicheck job(s)`);
    } catch (err) {
      console.error("tick failed:", err);
    }
  };

  await tick(); // run once at boot, then on the interval
  const timer = setInterval(() => void tick(), TICK_INTERVAL_MS);

  // ---- graceful shutdown ----
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`worker: received ${signal}, shutting down`);
    clearInterval(timer);
    await runner.stop();
    await utils.release();
    await sql.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await runner.promise; // resolves when the runner stops
}

main().catch((err: unknown) => {
  console.error("worker failed to start:", err);
  process.exit(1);
});
