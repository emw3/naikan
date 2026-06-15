/**
 * Incident orchestrator (issue #09) — the thin glue that runs after every
 * CheckRun write (worker job + API "Run now"). It reads the I/O the pure
 * `@naikan/incident-machine` needs — the check's *effective* alert-after-N-fails
 * (CheckGroup inheritance resolved, #08), the recent run tail, and the open
 * incident — runs the machine, and persists the single resulting transition.
 *
 * The decision lives entirely in the machine; this only does the reads/writes.
 * Alerting (#10): when an `alerter` is injected, a transition that opens or closes
 * an incident is resolved into a DB-free `IncidentAlertEvent` (project routing +
 * check label + error/duration) and handed to the callback best-effort. With no
 * `alerter`, incidents transition silently (the #09 behaviour). The event type is
 * owned by `@naikan/alerter`; the callback runtime is injected by the apps, so
 * config-repo keeps no runtime coupling to email/Slack.
 */
import { evaluateIncident, SUCCESSES_TO_CLOSE, type RunPoint } from "@naikan/incident-machine";
import type { IncidentAlertEvent } from "@naikan/alerter";
import type { ConfigRepo } from "./repo.ts";
import type { CheckRun, Incident } from "./types.ts";

export interface ApplyIncidentDeps {
  repo: ConfigRepo;
  /** The check whose just-recorded run should be evaluated. */
  checkId: string;
  /**
   * Optional incident-alert sink (#10). Called best-effort after a transition
   * opens or closes an incident; it owns its own failure handling and must not
   * throw. Omitted → incidents transition silently.
   */
  alerter?: (event: IncidentAlertEvent) => Promise<void>;
}

/**
 * Resolve incident state after a CheckRun: open on N consecutive fails, close on
 * 2 consecutive successes, else no-op. Returns the affected Incident, or null
 * when nothing changed (or the check no longer exists).
 */
export async function applyIncidentForRun(deps: ApplyIncidentDeps): Promise<Incident | null> {
  const { repo, checkId } = deps;

  const effective = await repo.getEffectiveCheck(checkId);
  if (!effective) return null;
  const n = effective.alertAfterNFails;

  // Enough history to detect both open (N trailing fails) and close (2 passes).
  const windowSize = Math.max(n, SUCCESSES_TO_CLOSE);
  const tail = (await repo.listRuns(checkId, windowSize)).slice().reverse(); // oldest → newest
  const open = await repo.getOpenIncident(checkId);

  const runs: RunPoint[] = tail.map((r) => ({ status: r.status, startedAt: r.startedAt }));
  const transition = evaluateIncident({
    runs,
    open: open ? { openedAt: open.openedAt } : null,
    alertAfterNFails: n,
  });

  if (transition.kind === "opened") {
    const incident = await repo.openIncident({
      checkId,
      openedAt: transition.openedAt,
      runIds: trailingFailIds(tail),
    });
    if (deps.alerter) {
      const event = await resolveEvent(repo, checkId, "opened", incident, tail.at(-1)?.error ?? null);
      if (event) await deps.alerter(event);
    }
    return incident;
  }
  if (transition.kind === "closed-recovered" && open) {
    const closingPassIds = tail.slice(tail.length - SUCCESSES_TO_CLOSE).map((r) => r.id);
    const incident = await repo.closeIncident(open.id, {
      closedAt: transition.closedAt,
      runIds: [...new Set([...open.runIds, ...closingPassIds])],
    });
    if (deps.alerter && incident) {
      const event = await resolveEvent(repo, checkId, "recovered", incident, null);
      if (event) await deps.alerter(event);
    }
    return incident;
  }
  return null;
}

/**
 * Resolve the project routing + a readable check label for an incident, producing
 * the DB-free event the alerter consumes. Returns null if the check/site/project
 * chain is missing (deleted mid-flight) — alerting is then skipped.
 */
async function resolveEvent(
  repo: ConfigRepo,
  checkId: string,
  kind: "opened" | "recovered",
  incident: Incident,
  error: string | null,
): Promise<IncidentAlertEvent | null> {
  const check = await repo.getCheck(checkId);
  if (!check) return null;
  const site = await repo.getSite(check.siteId);
  if (!site) return null;
  const project = await repo.getProject(site.projectId);
  if (!project) return null;

  const durationMs =
    kind === "recovered" && incident.closedAt
      ? incident.closedAt.getTime() - incident.openedAt.getTime()
      : null;

  return {
    kind,
    checkType: "heartbeat",
    projectId: project.id,
    projectName: project.name,
    routing: { alertEmails: project.alertEmails, slackWebhookUrl: project.slackWebhookUrl },
    checkLabel: `${hostOf(site.baseUrl)}${check.path}`,
    error: kind === "opened" ? error : null,
    openedAt: incident.openedAt,
    closedAt: kind === "recovered" ? incident.closedAt : null,
    durationMs,
  };
}

// ---- UI checks (#14): reuse the same machine + alerter, gated on critical fail ----

/**
 * Consecutive critical-signal fails that open a UI incident. Fixed at 1: a UI
 * check runs once a day, and the PRD treats a critical-signal failure (e.g. the
 * page didn't load) as an outage to page on immediately — there is no per-check
 * override (#14).
 */
export const UI_ALERT_AFTER_N_FAILS = 1;

export interface ApplyUIIncidentDeps {
  repo: ConfigRepo;
  /** The UI check whose just-recorded run should be evaluated. */
  checkId: string;
  /**
   * Optional incident-alert sink. Called best-effort after a transition opens or
   * closes a UI incident; must not throw. Omitted → transitions silently.
   */
  alerter?: (event: IncidentAlertEvent) => Promise<void>;
}

/**
 * Resolve incident state after a *UI* CheckRun (#14). Identical machinery to
 * `applyIncidentForRun`, but the incident-relevant signal is `criticalFailed`
 * (did a `critical`-severity Signal fail?), not `status` — a run can fail its
 * `status` on a warning signal or a visual regression and still be
 * critical-healthy, in which case it does not open/sustain an incident and counts
 * toward recovery. Opens on the first critical fail; closes after 2 consecutive
 * critical-passes (≈48h at daily cadence — the recovery-alert lag is expected).
 */
export async function applyUIIncidentForRun(deps: ApplyUIIncidentDeps): Promise<Incident | null> {
  const { repo, checkId } = deps;

  const check = await repo.getUICheck(checkId);
  if (!check) return null;
  const n = UI_ALERT_AFTER_N_FAILS;

  const windowSize = Math.max(n, SUCCESSES_TO_CLOSE);
  const tail = (await repo.listRuns(checkId, windowSize)).slice().reverse(); // oldest → newest
  const open = await repo.getOpenIncident(checkId);

  const runs: RunPoint[] = tail.map((r) => ({
    status: r.criticalFailed ? "fail" : "pass",
    startedAt: r.startedAt,
  }));
  const transition = evaluateIncident({
    runs,
    open: open ? { openedAt: open.openedAt } : null,
    alertAfterNFails: n,
  });

  if (transition.kind === "opened") {
    const incident = await repo.openIncident({
      checkId,
      openedAt: transition.openedAt,
      runIds: trailingCriticalFailIds(tail),
    });
    if (deps.alerter) {
      const event = await resolveUIEvent(repo, checkId, "opened", incident, tail.at(-1)?.error ?? null);
      if (event) await deps.alerter(event);
    }
    return incident;
  }
  if (transition.kind === "closed-recovered" && open) {
    const closingPassIds = tail.slice(tail.length - SUCCESSES_TO_CLOSE).map((r) => r.id);
    const incident = await repo.closeIncident(open.id, {
      closedAt: transition.closedAt,
      runIds: [...new Set([...open.runIds, ...closingPassIds])],
    });
    if (deps.alerter && incident) {
      const event = await resolveUIEvent(repo, checkId, "recovered", incident, null);
      if (event) await deps.alerter(event);
    }
    return incident;
  }
  return null;
}

/**
 * Resolve the project routing + check label for a UI incident (the UICheck → site
 * → project chain). Tags the event `checkType: "uicheck"` so the alerter renders
 * UI-specific copy. Returns null if the chain is missing (deleted mid-flight).
 */
async function resolveUIEvent(
  repo: ConfigRepo,
  checkId: string,
  kind: "opened" | "recovered",
  incident: Incident,
  error: string | null,
): Promise<IncidentAlertEvent | null> {
  const check = await repo.getUICheck(checkId);
  if (!check) return null;
  const site = await repo.getSite(check.siteId);
  if (!site) return null;
  const project = await repo.getProject(site.projectId);
  if (!project) return null;

  const durationMs =
    kind === "recovered" && incident.closedAt
      ? incident.closedAt.getTime() - incident.openedAt.getTime()
      : null;

  return {
    kind,
    checkType: "uicheck",
    projectId: project.id,
    projectName: project.name,
    routing: { alertEmails: project.alertEmails, slackWebhookUrl: project.slackWebhookUrl },
    checkLabel: `${hostOf(site.baseUrl)}${check.path}`,
    error: kind === "opened" ? error : null,
    openedAt: incident.openedAt,
    closedAt: kind === "recovered" ? incident.closedAt : null,
    durationMs,
  };
}

/** Host of a base URL, falling back to the raw string if unparseable. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Ids of the trailing failing-streak runs (oldest → newest) — the opening window. */
function trailingFailIds(runs: CheckRun[]): string[] {
  const ids: string[] = [];
  for (let i = runs.length - 1; i >= 0 && runs[i]!.status === "fail"; i--) ids.unshift(runs[i]!.id);
  return ids;
}

/** Ids of the trailing critical-fail streak (oldest → newest) — the UI opening window. */
function trailingCriticalFailIds(runs: CheckRun[]): string[] {
  const ids: string[] = [];
  for (let i = runs.length - 1; i >= 0 && runs[i]!.criticalFailed; i--) ids.unshift(runs[i]!.id);
  return ids;
}
