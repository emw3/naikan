/**
 * Types for `@naikan/digest-builder` (issue #15, PRD deep module 6) — the pure
 * function that turns one project's last-24h Check runs + Incidents into the
 * summary payload rendered into the daily digest email + Slack message.
 *
 * The builder takes *pre-shaped* inputs (`DigestRun` / `DigestIncident`): the
 * caller (worker glue) has already resolved each run/incident to its human check
 * label, so the builder stays a pure, DB-free, dependency-free kernel. No TS
 * parameter properties / enums / namespaces (imported by the Node strip-only
 * worker, ADR-0001/0005).
 */

/** Which check family a run/summary belongs to. Mirrors config-repo's `CheckType`. */
export type CheckType = "heartbeat" | "uicheck";

/** A half-open window `[from, to)`. A run counts when `from <= startedAt < to`. */
export interface DateRange {
  /** Inclusive lower bound. */
  from: Date;
  /** Exclusive upper bound. */
  to: Date;
}

/** A Check run as the digest sees it — the caller attaches the human label. */
export interface DigestRun {
  checkId: string;
  /** Human label, e.g. "acme.test/health". */
  checkLabel: string;
  checkType: CheckType;
  status: "pass" | "fail";
  /** UI checks only: did a `critical` signal fail? Null for heartbeat runs. */
  criticalFailed: boolean | null;
  startedAt: Date;
}

/** An Incident as the digest sees it — the caller attaches the human label. */
export interface DigestIncident {
  checkId: string;
  checkLabel: string;
  openedAt: Date;
  /** Null while the incident is still open. */
  closedAt: Date | null;
}

/** Everything `buildDigest` needs for one project over one window. */
export interface BuildDigestInput {
  projectId: string;
  projectName: string;
  range: DateRange;
  runs: DigestRun[];
  incidents: DigestIncident[];
  /** Deep-link to the project's dashboard overview. */
  dashboardUrl: string;
}

/** Pass/fail tally for one check over the window. */
export interface CheckSummary {
  checkId: string;
  checkLabel: string;
  checkType: CheckType;
  passed: number;
  failed: number;
}

/** A UI check that had at least one failing run in the window (a digest regression). */
export interface RegressedUICheck {
  checkId: string;
  checkLabel: string;
  /** How many of its runs failed in the window. */
  failed: number;
}

/** One incident as summarised in the digest. */
export interface IncidentSummary {
  checkId: string;
  checkLabel: string;
  openedAt: Date;
  closedAt: Date | null;
  /** `closedAt - openedAt` in ms; null while still open. */
  durationMs: number | null;
}

/** The summary structure rendered into the email + Slack message. */
export interface DigestPayload {
  projectId: string;
  projectName: string;
  range: DateRange;
  /** Window-wide run totals (sum across `checks`). */
  totals: { runs: number; passed: number; failed: number };
  /** Per-check pass/fail counts, in first-seen order. */
  checks: CheckSummary[];
  /** UI checks with one or more failing runs in the window. */
  regressedUIChecks: RegressedUICheck[];
  /** Incidents opened within the window, and incidents closed within the window. */
  incidents: { opened: IncidentSummary[]; closed: IncidentSummary[] };
  dashboardUrl: string;
}
