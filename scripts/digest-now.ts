/**
 * Sends the daily digest immediately, once, for every Project — the on-demand
 * counterpart to the worker's cron (issue #15). Use it to test the digest or to
 * force one out of band: `bun run digest:now`.
 *
 * Same env as the worker:
 *   - DATABASE_URL                      (required) — Postgres with migrations applied
 *   - RESEND_API_KEY + ALERT_FROM_EMAIL (optional) — enable email; omit for Slack-only
 *   - APP_BASE_URL                      (optional) — dashboard deep-links (default localhost:3000)
 * Per-project Slack routing is the webhook on each Project; the per-project
 * digest_email_enabled / digest_slack_enabled toggles gate delivery. Sends are
 * best-effort (a failed channel is logged, never aborts the run).
 */
// Relative imports into the source tree: scripts run from the repo root, where
// bare `@naikan/*` specifiers don't resolve (bun links workspace packages
// per-package, not hoisted to root) — same convention as scripts/seed-admin.ts.
import { closeDb, db } from "../apps/api/src/db.ts";
import { createConfigRepo, createPgConfigStore } from "../packages/config-repo/src/index.ts";
import { createLiveChannels } from "../packages/alerter/src/index.ts";
import { runDigestSend } from "../apps/worker/src/digest-job.ts";

const appBaseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
if (!process.env.RESEND_API_KEY || !process.env.ALERT_FROM_EMAIL) {
  console.log(
    "digest:now — email not configured (set RESEND_API_KEY + ALERT_FROM_EMAIL); sending Slack-only",
  );
}

const repo = createConfigRepo(createPgConfigStore(db));
const channels = createLiveChannels({
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  fromEmail: process.env.ALERT_FROM_EMAIL ?? "",
});

try {
  const result = await runDigestSend({ repo, channels, appBaseUrl, now: () => new Date() });
  console.log(
    `digest:now PASS — ${result.projects} project(s) → ${result.emails} email(s), ${result.slackPosts} Slack post(s)`,
  );
  await closeDb();
  process.exit(0);
} catch (err) {
  console.error(`digest:now FAIL — ${err instanceof Error ? err.message : String(err)}`);
  await closeDb();
  process.exit(1);
}
