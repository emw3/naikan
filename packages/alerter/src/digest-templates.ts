/**
 * Daily-digest message templates (issue #15). The digest is the low-noise
 * counterpart to the realtime incident alert: one email per account manager
 * aggregating all their projects, and one Slack message per project (per the
 * per-channel opt-in on Project).
 *
 * Pure rendering over the `DigestPayload` that `@naikan/digest-builder`
 * produces — plain text for MVP, mirroring `templates.ts` (renderEmail/
 * renderSlack), so a richer HTML email can slot in later without touching the
 * dispatch glue. No I/O, no clock.
 */
import type { DigestPayload, IncidentSummary } from "@naikan/digest-builder";
import type { EmailMessage } from "./types.ts";
import { formatDuration } from "./templates.ts";

/** One-line pass/fail tally, e.g. "8/10 runs passed, 2 failed". */
function tally(p: DigestPayload): string {
  const { runs, passed, failed } = p.totals;
  if (runs === 0) return "No checks ran in the last 24h";
  return `${passed}/${runs} runs passed, ${failed} failed`;
}

/** Render one incident as a digest bullet, with downtime when it closed. */
function incidentLine(i: IncidentSummary): string {
  if (i.durationMs !== null) {
    return `${i.checkLabel} — down ${formatDuration(i.durationMs)}`;
  }
  return `${i.checkLabel} — opened ${i.openedAt.toISOString()}, still open`;
}

/** The per-project block shared by the email body (one block per project). */
function projectBlock(p: DigestPayload): string {
  const lines: string[] = [`== ${p.projectName} ==`, tally(p)];

  if (p.regressedUIChecks.length) {
    lines.push("Regressed UI checks:");
    for (const r of p.regressedUIChecks) lines.push(`  - ${r.checkLabel} (${r.failed} failed)`);
  }
  if (p.incidents.opened.length) {
    lines.push(`Incidents opened (${p.incidents.opened.length}):`);
    for (const i of p.incidents.opened) lines.push(`  - ${incidentLine(i)}`);
  }
  if (p.incidents.closed.length) {
    lines.push(`Incidents closed (${p.incidents.closed.length}):`);
    for (const i of p.incidents.closed) lines.push(`  - ${incidentLine(i)}`);
  }
  lines.push(`Dashboard: ${p.dashboardUrl}`);
  return lines.join("\n");
}

/**
 * Render the digest email for one account manager covering all their projects.
 * Subject names the project count; the body has one `projectBlock` per project.
 */
export function renderDigestEmail(managerName: string, payloads: DigestPayload[]): EmailMessage {
  const subject = `Naikan daily digest — ${payloads.length} project${payloads.length === 1 ? "" : "s"}`;
  const lines: string[] = [`Hi ${managerName},`, ""];
  if (payloads.length === 0) {
    lines.push("You have no projects assigned.");
  } else {
    lines.push("Here is the last 24h across your projects.", "");
    lines.push(payloads.map(projectBlock).join("\n\n"));
  }
  return { subject, text: lines.join("\n") };
}

/** Render the per-project Slack digest message (posted to the project's channel). */
export function renderDigestSlack(p: DigestPayload): string {
  const lines: string[] = [`*${p.projectName}* — daily digest`, tally(p)];
  if (p.regressedUIChecks.length) {
    lines.push(`Regressed: ${p.regressedUIChecks.map((r) => r.checkLabel).join(", ")}`);
  }
  const opened = p.incidents.opened.length;
  const closed = p.incidents.closed.length;
  if (opened || closed) {
    lines.push(`Incidents: ${opened} opened, ${closed} closed`);
  }
  lines.push(p.dashboardUrl);
  return lines.join("\n");
}
