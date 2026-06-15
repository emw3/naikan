/**
 * Heartbeat job handler — the unit the worker runs for each enqueued job.
 *
 * It loads the check and its site, executes the (injectable) runner against the
 * site's base URL, and persists the resulting `CheckRun`. There is deliberately
 * **no scheduling logic here**: the tick + `@naikan/scheduler` decide *when* a
 * check runs; this only runs the check it is handed. Mirrors the synchronous
 * "Run now" route (apps/api), differing only in that the queue invokes it.
 *
 * The runner is injected (`runCheck`) so the handler is testable without real
 * network/DNS/TLS; it defaults to the live `@naikan/heartbeat-runner`.
 */
import { runHeartbeat, type CheckRunResult } from "@naikan/heartbeat-runner";
import { applyIncidentForRun, type CheckRun, type ConfigRepo, type HeartbeatCheck } from "@naikan/config-repo";
import type { IncidentAlertEvent } from "@naikan/alerter";

/** Executes one check against a site base URL. Defaults to the live runner. */
export type RunCheck = (baseUrl: string, check: HeartbeatCheck) => Promise<CheckRunResult>;

export interface RunHeartbeatJobDeps {
  repo: ConfigRepo;
  /** Override the executor in tests; defaults to the real `runHeartbeat`. */
  runCheck?: RunCheck;
  /** Optional incident-alert sink (#10); omitted → silent transitions. */
  alerter?: (event: IncidentAlertEvent) => Promise<void>;
}

const liveRunCheck: RunCheck = (baseUrl, check) =>
  runHeartbeat(baseUrl, {
    path: check.path,
    bodyAssertion: check.bodyAssertion,
    certCheck: check.certCheck,
    dnsCheck: check.dnsCheck,
  });

/**
 * Run one heartbeat check and persist its CheckRun. Returns the recorded run, or
 * null when the check (or its site) no longer exists — a check deleted between
 * enqueue and execution is a no-op, not an error.
 */
export async function runHeartbeatJob(
  checkId: string,
  deps: RunHeartbeatJobDeps,
): Promise<CheckRun | null> {
  const { repo } = deps;
  const runCheck = deps.runCheck ?? liveRunCheck;

  const check = await repo.getCheck(checkId);
  if (!check) return null;
  const site = await repo.getSite(check.siteId);
  if (!site) return null;

  const result = await runCheck(site.baseUrl, check);
  const run = await repo.recordRun({
    checkId: check.id,
    checkType: "heartbeat",
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    status: result.status,
    latencyMs: result.latencyMs,
    error: result.error,
  });
  // After each CheckRun, resolve incident state (open on N fails / close on 2 passes)
  // and fire the alert on a transition (#10) when an alerter is wired.
  await applyIncidentForRun({ repo, checkId: check.id, alerter: deps.alerter });
  return run;
}
