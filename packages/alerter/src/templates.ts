/**
 * Alert message templates (issue #10). One subject + body per transition, with a
 * deep-link to the project's dashboard. Plain text for MVP — a richer HTML email
 * can slot in behind `renderEmail` later without touching `dispatch`.
 */
import type { Alert, EmailMessage } from "./types.ts";

/** Humanise a millisecond span as `Xm` or `Xh Ym` (mirrors the dashboard). */
export function formatDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Subject line shared by email + Slack, per check type (#14). Heartbeat alerts
 * read as "Incident opened/recovered"; UI-check alerts as "UI check
 * failed/recovered" (the failure is a critical signal, not an outage). An absent
 * `checkType` is treated as heartbeat, so #10's wording is unchanged.
 */
function subjectFor(alert: Alert): string {
  if ((alert.checkType ?? "heartbeat") === "uicheck") {
    const noun = alert.kind === "opened" ? "failed" : "recovered";
    return `UI check ${noun} for ${alert.projectName} / ${alert.checkLabel}`;
  }
  const verb = alert.kind === "opened" ? "opened" : "recovered";
  return `Incident ${verb} for ${alert.projectName} / ${alert.checkLabel}`;
}

/** Render the email subject + plain-text body for an alert. */
export function renderEmail(alert: Alert): EmailMessage {
  const subject = subjectFor(alert);
  const lines: string[] = [subject, ""];
  if (alert.kind === "opened") {
    lines.push(
      (alert.checkType ?? "heartbeat") === "uicheck"
        ? `UI check failed at ${alert.openedAt.toISOString()}.`
        : `Opened at ${alert.openedAt.toISOString()}.`,
    );
    lines.push(`Error: ${alert.error ?? "(no detail)"}.`);
  } else {
    lines.push(`Recovered at ${alert.closedAt.toISOString()}.`);
    lines.push(
      `Down for ${formatDuration(alert.durationMs)} (opened ${alert.openedAt.toISOString()}).`,
    );
  }
  lines.push("", `Dashboard: ${alert.dashboardUrl}`);
  return { subject, text: lines.join("\n") };
}

/** Render the Slack message text for an alert. */
export function renderSlack(alert: Alert): string {
  const head = subjectFor(alert);
  const detail =
    alert.kind === "opened"
      ? `Error: ${alert.error ?? "(no detail)"}`
      : `Down for ${formatDuration(alert.durationMs)}`;
  return `${head}\n${detail}\n${alert.dashboardUrl}`;
}
