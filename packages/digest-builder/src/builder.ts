/**
 * `buildDigest` — pure aggregation of one project's last-24h activity into the
 * digest payload (issue #15, PRD deep module 6). No clock, no DB, no I/O: the
 * caller passes the window plus the runs/incidents (already labelled), and gets
 * back the summary the email + Slack templates render.
 *
 * Window semantics are half-open `[from, to)`: a run/incident-edge at exactly
 * `to` belongs to the *next* day, never this one — so back-to-back daily windows
 * partition time without double-counting the boundary.
 */
import type {
  BuildDigestInput,
  CheckSummary,
  DigestIncident,
  DigestPayload,
  IncidentSummary,
  RegressedUICheck,
} from "./types.ts";

export function buildDigest(input: BuildDigestInput): DigestPayload {
  const { range } = input;
  const inWindow = (d: Date): boolean =>
    d.getTime() >= range.from.getTime() && d.getTime() < range.to.getTime();

  // Per-check pass/fail tally over the windowed runs, preserving first-seen order.
  const byCheck = new Map<string, CheckSummary>();
  for (const r of input.runs) {
    if (!inWindow(r.startedAt)) continue;
    let summary = byCheck.get(r.checkId);
    if (!summary) {
      summary = {
        checkId: r.checkId,
        checkLabel: r.checkLabel,
        checkType: r.checkType,
        passed: 0,
        failed: 0,
      };
      byCheck.set(r.checkId, summary);
    }
    if (r.status === "pass") summary.passed += 1;
    else summary.failed += 1;
  }
  const checks = [...byCheck.values()];

  // A UI check is "regressed" in the digest when any of its runs failed in the
  // window (visual diff / console / perf / selector — all roll into the digest).
  const regressedUIChecks: RegressedUICheck[] = checks
    .filter((c) => c.checkType === "uicheck" && c.failed > 0)
    .map((c) => ({ checkId: c.checkId, checkLabel: c.checkLabel, failed: c.failed }));

  const opened = input.incidents.filter((i) => inWindow(i.openedAt)).map(toIncidentSummary);
  const closed = input.incidents
    .filter((i) => i.closedAt !== null && inWindow(i.closedAt))
    .map(toIncidentSummary);

  const passed = checks.reduce((n, c) => n + c.passed, 0);
  const failed = checks.reduce((n, c) => n + c.failed, 0);

  return {
    projectId: input.projectId,
    projectName: input.projectName,
    range,
    totals: { runs: passed + failed, passed, failed },
    checks,
    regressedUIChecks,
    incidents: { opened, closed },
    dashboardUrl: input.dashboardUrl,
  };
}

function toIncidentSummary(i: DigestIncident): IncidentSummary {
  return {
    checkId: i.checkId,
    checkLabel: i.checkLabel,
    openedAt: i.openedAt,
    closedAt: i.closedAt,
    durationMs: i.closedAt ? i.closedAt.getTime() - i.openedAt.getTime() : null,
  };
}
