/**
 * Daily digest job (issue #15) — the low-noise counterpart to the realtime
 * incident alert. Once a day the worker runs `runDigestSend`, which:
 *
 *   1. builds one `DigestPayload` per Project over the last-24h window (gathering
 *      that project's Check runs + Incidents via config-repo, the only DB seam),
 *   2. posts a per-project Slack message to each opted-in project's webhook, and
 *   3. sends ONE aggregated email per account manager covering all of their
 *      email-opted-in projects.
 *
 * The digest summarisation is pure (`@naikan/digest-builder`); rendering is
 * pure (`@naikan/alerter`); this function is the I/O glue around them. Repo,
 * channels, and clock are injected so the whole path is testable with the
 * in-memory store + recording fakes (no graphile-worker, no live email/Slack).
 *
 * Dispatch is best-effort per message: one failed send is logged and skipped,
 * never aborting the rest of the run (mirrors the incident alerter's `dispatch`).
 */
import type { Project, ConfigRepo } from "@naikan/config-repo";
import {
  buildDigest,
  type DateRange,
  type DigestIncident,
  type DigestPayload,
  type DigestRun,
} from "@naikan/digest-builder";
import { renderDigestEmail, renderDigestSlack, type EmailMessage } from "@naikan/alerter";

/** The injectable channel adapters — same shape as the alerter's `AlertChannels`. */
export interface DigestChannels {
  sendEmail: (to: string[], message: EmailMessage) => Promise<void>;
  postSlack: (webhookUrl: string, text: string) => Promise<void>;
}

export interface RunDigestSendDeps {
  repo: ConfigRepo;
  channels: DigestChannels;
  /** Dashboard base URL for deep-links (e.g. `http://localhost:3000`). */
  appBaseUrl: string;
  /** Current time, injected for determinism. The window ends here. */
  now: () => Date;
  /** Window length ending at `now`. Defaults to 24h. */
  windowMs?: number;
}

/** What one digest run dispatched. */
export interface DigestSendResult {
  /** Projects summarised (every project, regardless of opt-ins). */
  projects: number;
  /** Aggregated manager emails sent. */
  emails: number;
  /** Per-project Slack messages posted. */
  slackPosts: number;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Host portion of a base URL, for the human check label (matches incident alerts). */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Deep-link to a project's dashboard overview (matches the incident alerter). */
function dashboardUrl(appBaseUrl: string, projectId: string): string {
  return `${appBaseUrl.replace(/\/+$/, "")}/#/projects/${projectId}`;
}

/** Gather one project's windowed runs + incidents and build its digest payload. */
async function buildProjectDigest(
  repo: ConfigRepo,
  project: Project,
  range: DateRange,
  appBaseUrl: string,
): Promise<DigestPayload> {
  const sites = await repo.listSites(project.id);
  const runs: DigestRun[] = [];
  // checkId → human label, reused to label the project's incidents.
  const labelByCheck = new Map<string, string>();

  for (const site of sites) {
    const host = hostOf(site.baseUrl);
    const heartbeats = await repo.listChecks(site.id);
    const uichecks = await repo.listUIChecks(site.id);
    const checks = [
      ...heartbeats.map((c) => ({ id: c.id, path: c.path, type: "heartbeat" as const })),
      ...uichecks.map((c) => ({ id: c.id, path: c.path, type: "uicheck" as const })),
    ];
    for (const check of checks) {
      const label = `${host}${check.path}`;
      labelByCheck.set(check.id, label);
      const checkRuns = await repo.listRunsInWindow(check.id, range.from, range.to);
      for (const r of checkRuns) {
        runs.push({
          checkId: check.id,
          checkLabel: label,
          checkType: check.type,
          status: r.status,
          criticalFailed: r.criticalFailed,
          startedAt: r.startedAt,
        });
      }
    }
  }

  const incidentRows = await repo.listProjectIncidents(project.id);
  const incidents: DigestIncident[] = incidentRows.map((i) => ({
    checkId: i.checkId,
    checkLabel: labelByCheck.get(i.checkId) ?? i.checkId,
    openedAt: i.openedAt,
    closedAt: i.closedAt,
  }));

  return buildDigest({
    projectId: project.id,
    projectName: project.name,
    range,
    runs,
    incidents,
    dashboardUrl: dashboardUrl(appBaseUrl, project.id),
  });
}

/** Best-effort send: log and swallow transport failures so one bad send can't abort the run. */
async function safeSend(fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    console.error("digest: dispatch failed:", err);
    return false;
  }
}

/** Run one daily digest pass over every project. Returns what it dispatched. */
export async function runDigestSend(deps: RunDigestSendDeps): Promise<DigestSendResult> {
  const { repo, channels, appBaseUrl } = deps;
  const to = deps.now();
  const from = new Date(to.getTime() - (deps.windowMs ?? DEFAULT_WINDOW_MS));
  const range: DateRange = { from, to };

  const projects = await repo.listProjects();
  const entries = await Promise.all(
    projects.map(async (project) => ({
      project,
      payload: await buildProjectDigest(repo, project, range, appBaseUrl),
    })),
  );

  // Slack: one message per opted-in project with a configured webhook.
  let slackPosts = 0;
  for (const { project, payload } of entries) {
    const webhook = project.slackWebhookUrl;
    if (!project.digestSlackEnabled || !webhook) continue;
    if (await safeSend(() => channels.postSlack(webhook, renderDigestSlack(payload)))) {
      slackPosts += 1;
    }
  }

  // Email: aggregate each manager's email-opted-in projects into one message.
  const byManager = new Map<string, DigestPayload[]>();
  for (const { project, payload } of entries) {
    if (!project.digestEmailEnabled || !project.assignedManagerId) continue;
    const list = byManager.get(project.assignedManagerId) ?? [];
    list.push(payload);
    byManager.set(project.assignedManagerId, list);
  }

  let emails = 0;
  for (const [managerId, payloads] of byManager) {
    const manager = await repo.getUser(managerId);
    if (!manager?.email) continue; // unassigned/soft-deleted manager → no recipient
    const message = renderDigestEmail(manager.email, payloads);
    if (await safeSend(() => channels.sendEmail([manager.email], message))) {
      emails += 1;
    }
  }

  return { projects: projects.length, emails, slackPosts };
}
