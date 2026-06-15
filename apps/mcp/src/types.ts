/**
 * Wire types for the Naikan HTTP API as the regression-judge agent sees it.
 *
 * These mirror the API's JSON responses, NOT the `@naikan/config-repo` domain
 * types: timestamps arrive as ISO strings (not `Date`), and only the fields the
 * agent needs to judge a run are modelled. The MCP package stays decoupled from
 * config-repo — it talks to the platform over HTTP like any other MCP client.
 */

/** The four verdict kinds — fixed vocabulary, mirrored from the API/DB constraint. */
export type VerdictKind = "real_regression" | "noise" | "intentional" | "uncertain";

/** A UI check as returned by the discovery endpoint `GET /api/uichecks`. */
export interface UICheckSummary {
  id: string;
  siteId: string;
  /** Path appended to the site base URL, e.g. `/pricing`. */
  path: string;
  /** Viewport labels this check captures (e.g. `["mobile","tablet","desktop"]`). */
  viewports: string[];
  /** Approved-baseline artifact ref, or null until a run has been promoted. */
  baselineImageRef: string | null;
}

/** One recorded execution of a check, as returned in run lists/detail. */
export interface CheckRun {
  id: string;
  checkId: string;
  status: "pass" | "fail";
  /** ISO-8601 timestamps over the wire. */
  startedAt: string;
  finishedAt: string;
  error: string | null;
  artifactsRef: string | null;
  /** Whether a critical signal failed this run (null for pre-signals runs). */
  criticalFailed: boolean | null;
}

/** One judged signal recorded against a viewport (#13). */
export interface Signal {
  kind: string;
  pass: boolean;
  severity: string;
  detail: string;
}

/** An agent regression-judge verdict recorded against a run. */
export interface AgentVerdict {
  id: string;
  runId: string;
  verdict: VerdictKind;
  confidence: number | null;
  reasoning: string;
  model: string;
  createdAt: string;
}

/**
 * Everything the agent needs to judge one run: the run row, presigned image URLs
 * for baseline | current | diff per viewport, the per-viewport diff fraction, the
 * judged signals, and the latest verdict already recorded (if any).
 */
export interface RunDetail {
  run: CheckRun;
  /** viewport → presigned URL of the current screenshot. */
  screenshots: Record<string, string>;
  /** viewport → { diff fraction 0..1, presigned overlay URL (null if no baseline) }. */
  diffs: Record<string, { pct: number; url: string | null }>;
  /** viewport → presigned URL of the approved baseline screenshot. */
  baseline: Record<string, string>;
  /** viewport → judged signals. */
  signals: Record<string, Signal[]>;
  /** The latest verdict recorded for this run, or null if none yet. */
  verdict: AgentVerdict | null;
  /** True once the run's artifacts have been reaped (retention) — images are gone. */
  expired: boolean;
}

/** Body the agent submits when recording a verdict. */
export interface VerdictInput {
  verdict: VerdictKind;
  reasoning: string;
  /** Self-reported confidence 0..1; omit if not applicable. */
  confidence?: number | null;
  /** The judging model's id, for provenance (e.g. `claude-opus-4-8`). */
  model: string;
}
