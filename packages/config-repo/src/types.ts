/**
 * Domain types for the `config-repo` module (PRD data model) and the low-level
 * persistence interface it sits on top of.
 *
 * `config-repo` is the only DB-access path for Project / Site (and, later, the
 * check entities). The repo (`repo.ts`) owns validation and audit-logging; the
 * `ConfigStore` below is dumb CRUD, with an in-memory implementation for tests
 * and a Postgres implementation for production — mirroring the auth module.
 */

/** A monitored project: routing + retention config, owned by one account manager. */
export interface Project {
  id: string;
  name: string;
  /** Free-text contacts (names, emails, phone) — not parsed. */
  contacts: string;
  /** Slack channel for per-project alerts, e.g. `#project-acme`. Null when unset. */
  slackChannel: string | null;
  /** Slack incoming-webhook URL for per-project alerts (#10). Null when unset. */
  slackWebhookUrl: string | null;
  /** Recipients for alert email. May be empty. */
  alertEmails: string[];
  /** Artifact retention window in days (PRD default 90). Always positive. */
  retentionDays: number;
  /** FK to the assigned account-manager User, or null if unassigned. */
  assignedManagerId: string | null;
  /** Include this project in the manager's daily digest email (#15). Default true. */
  digestEmailEnabled: boolean;
  /** Post this project's daily digest to its Slack channel (#15). Default true. */
  digestSlackEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** A monitored site under a Project (e.g. production vs staging), keyed by base URL. */
export interface Site {
  id: string;
  projectId: string;
  baseUrl: string;
  createdAt: Date;
  updatedAt: Date;
}

/** How a heartbeat check asserts on the response body. */
export interface BodyAssertion {
  /** `regex` matches the raw body; `jsonpath` resolves a dot-path in parsed JSON. */
  kind: "regex" | "jsonpath";
  /** Regex source (kind=regex) or dot-path like `data.status` (kind=jsonpath). */
  pattern: string;
  /** jsonpath only: the resolved value must equal this string. */
  equals?: string;
}

/**
 * Alert routing policy carried by a CheckGroup (issue #08). Shape mirrors the
 * Project routing fields; consumed by the alerter (#10). Stored as jsonb.
 */
export interface AlertRouting {
  /** Slack channel for this group's alerts, e.g. `#prod-critical`. Null when unset. */
  slackChannel: string | null;
  /** Recipients for this group's alert email. May be empty. */
  alertEmails: string[];
}

/**
 * A reusable policy (per project) that HeartbeatChecks inherit defaults from
 * (issue #08). Each default is nullable: a null default means "fall through to
 * the system default" (`check ?? group ?? system`).
 */
export interface CheckGroup {
  id: string;
  projectId: string;
  name: string;
  /** Default run interval inherited by member checks that leave it null. */
  defaultIntervalSeconds: number | null;
  /** Default alert routing inherited by member checks (no per-check override). */
  defaultAlertRouting: AlertRouting | null;
  /** Default consecutive-fails-to-open inherited by member checks that leave it null. */
  defaultAlertAfterNFails: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields accepted when creating a CheckGroup. */
export interface CheckGroupInput {
  projectId: string;
  name: string;
  defaultIntervalSeconds?: number | null;
  defaultAlertRouting?: AlertRouting | null;
  defaultAlertAfterNFails?: number | null;
}

/** Updatable CheckGroup fields (the parent project is fixed once created). */
export type CheckGroupPatch = Partial<Omit<CheckGroupInput, "projectId">>;

/**
 * A heartbeat check under a Site (issue #06). `groupId`, `intervalSeconds`, and
 * `alertAfterNFails` are nullable: when null they inherit from the check's
 * CheckGroup (issue #08). Resolve with `resolveEffectiveCheck` — never read the
 * raw nullable fields for scheduling/alerting.
 */
export interface HeartbeatCheck {
  id: string;
  siteId: string;
  /** FK to the CheckGroup this check inherits from, or null (no group). */
  groupId: string | null;
  /** Request path appended to the site base URL, e.g. `/health`. Starts with `/`. */
  path: string;
  /** Optional response-body assertion, or null when not checked. */
  bodyAssertion: BodyAssertion | null;
  /** Inspect the TLS certificate expiry (https only). */
  certCheck: boolean;
  /** Resolve the hostname via DNS. */
  dnsCheck: boolean;
  /** How often the scheduler runs this check; null = inherit from the group. */
  intervalSeconds: number | null;
  /** Consecutive failures before an incident opens (#09); null = inherit. */
  alertAfterNFails: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields accepted when creating a HeartbeatCheck. */
export interface HeartbeatCheckInput {
  siteId: string;
  groupId?: string | null;
  path?: string;
  bodyAssertion?: BodyAssertion | null;
  certCheck?: boolean;
  dnsCheck?: boolean;
  intervalSeconds?: number | null;
  alertAfterNFails?: number | null;
}

/** Updatable HeartbeatCheck fields (the parent site is fixed once created). */
export type HeartbeatCheckPatch = Partial<Omit<HeartbeatCheckInput, "siteId">>;

/**
 * A HeartbeatCheck with inheritance resolved (issue #08): `intervalSeconds` and
 * `alertAfterNFails` are never null, and `alertRouting` carries the group's
 * routing (or null when no group). This is what the scheduler/dashboards read.
 */
export interface EffectiveHeartbeatCheck
  extends Omit<HeartbeatCheck, "intervalSeconds" | "alertAfterNFails"> {
  intervalSeconds: number;
  alertAfterNFails: number;
  alertRouting: AlertRouting | null;
}

/**
 * Per-signal severity on a UI check: `critical` can page realtime, `warning`
 * only contributes to the daily digest (PRD). Stored-but-unused until #13.
 */
export type Severity = "critical" | "warning";

/** Web-Vitals budget a UI check's perf signal is judged against. Stored-but-unused until #13. */
export interface PerfBudget {
  /** Largest Contentful Paint budget, milliseconds (PRD default 2500). */
  lcpMs: number;
  /** Total transferred page weight budget, bytes (PRD default 3 MB). */
  pageWeightBytes: number;
  /** Maximum request count (PRD default 100). */
  maxRequests: number;
}

/**
 * A daily browser-rendered check under a Site (issue #11). Captures screenshots
 * at each Viewport; `baselineImageRef`, `diffThreshold`, the per-signal severity
 * fields, `selectors`, `ignoreRegions`, and `perfBudget` are persisted here but
 * only consumed once diffing (#12) and signals (#13) land. `groupId` is nullable
 * (no group); routing inheritance mirrors HeartbeatCheck.
 */
export interface UICheck {
  id: string;
  siteId: string;
  /** FK to the CheckGroup this check belongs to, or null (no group). */
  groupId: string | null;
  /**
   * How often the scheduler runs this UI check, in seconds; null = inherit from
   * the group, then the system default (once daily, #14). Resolve with
   * `resolveEffectiveUICheck` — never read the raw nullable for scheduling.
   */
  intervalSeconds: number | null;
  /** Request path appended to the site base URL, e.g. `/pricing`. Starts with `/`. */
  path: string;
  /** Viewport labels to capture at (PRD default `[mobile, tablet, desktop]`). */
  viewports: string[];
  /** Required selectors that must be present (selector signal, #13). */
  selectors: string[];
  /** CSS selectors masked before diffing (#12). */
  ignoreRegions: string[];
  /** Web-Vitals budget (#13). */
  perfBudget: PerfBudget;
  /** Pixel-diff fail threshold as a fraction 0..1 (#12). */
  diffThreshold: number;
  severityLoad: Severity;
  severityConsole: Severity;
  severitySelector: Severity;
  severityPerf: Severity;
  /** Approved-baseline artifact ref, or null until a run is promoted (#12). */
  baselineImageRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields accepted when creating a UICheck (omitted fields fall back to PRD defaults). */
export interface UICheckInput {
  siteId: string;
  groupId?: string | null;
  /** Run cadence in seconds; null/omitted = inherit (group → daily, #14). */
  intervalSeconds?: number | null;
  path?: string;
  viewports?: string[];
  selectors?: string[];
  ignoreRegions?: string[];
  perfBudget?: Partial<PerfBudget> | null;
  diffThreshold?: number;
  severityLoad?: Severity;
  severityConsole?: Severity;
  severitySelector?: Severity;
  severityPerf?: Severity;
  baselineImageRef?: string | null;
}

/** Updatable UICheck fields (the parent site is fixed once created). */
export type UICheckPatch = Partial<Omit<UICheckInput, "siteId">>;

/**
 * A UICheck with cadence inheritance resolved (#14): `intervalSeconds` is never
 * null (check ?? group ?? daily system default). This is what the scheduler tick
 * reads. (UI incidents open on the first critical-signal fail — N is fixed at 1,
 * not a per-check field — so only the interval needs resolving here.)
 */
export interface EffectiveUICheck extends Omit<UICheck, "intervalSeconds"> {
  intervalSeconds: number;
}

/** Discriminates the check kind a CheckRun belongs to (uicheck arrives in #11). */
export type CheckType = "heartbeat" | "uicheck";

/** Outcome of one run of a check. */
export type CheckRunStatus = "pass" | "fail";

/** One recorded execution of a check (heartbeat or, later, uicheck). */
export interface CheckRun {
  id: string;
  checkId: string;
  checkType: CheckType;
  startedAt: Date;
  finishedAt: Date;
  status: CheckRunStatus;
  latencyMs: number;
  /** Failure summary, or null when the run passed. */
  error: string | null;
  /** Artifact-store reference (uicheck screenshots); null for heartbeats. */
  artifactsRef: string | null;
  /**
   * uicheck only (#14): did a `critical`-severity signal fail this run? This is
   * the incident-relevant predicate — distinct from `status`, which fails on
   * *any* signal/regression (digest). null for heartbeats (their `status` is the
   * incident-relevant signal).
   */
  criticalFailed: boolean | null;
}

/** Fields accepted when recording a CheckRun (id is generated). */
export interface CheckRunInput {
  checkId: string;
  checkType: CheckType;
  startedAt: Date;
  finishedAt: Date;
  status: CheckRunStatus;
  latencyMs: number;
  error?: string | null;
  artifactsRef?: string | null;
  /** uicheck only (#14): a critical-severity signal failed. Defaults to null. */
  criticalFailed?: boolean | null;
}

/**
 * An open or resolved incident for a check (PRD data model, issue #09). Opened
 * after N consecutive heartbeat fails, closed after 2 consecutive successes.
 * `checkId` is polymorphic (no FK), mirroring CheckRun. Resolve transitions with
 * `applyIncidentForRun`; never mutate these rows directly outside the repo.
 */
export interface Incident {
  id: string;
  /** The check this incident belongs to (polymorphic — no FK, like CheckRun). */
  checkId: string;
  /** When the failure that opened the incident began. */
  openedAt: Date;
  /** When the incident closed (2 consecutive successes), or null while still open. */
  closedAt: Date | null;
  /** Ids of the CheckRuns spanning the incident (opening fails + closing successes). */
  runIds: string[];
}

/**
 * The agent's classification of a UI run's visual diff (Naikan regression-judge):
 * a real visual `regression`, harmless `noise` (anti-aliasing, dynamic content),
 * an `intentional` change, or `uncertain` when the agent can't decide.
 */
export type VerdictKind = "real_regression" | "noise" | "intentional" | "uncertain";

/**
 * An AI agent's verdict on whether a UI check run's screenshot diff is a real
 * visual regression or noise, written via the `@naikan/mcp` server. Agent-generated
 * telemetry — NOT audited (like CheckRun / Incident). The run-detail UI shows the
 * latest verdict per run; the human stays in the loop (promote-to-baseline is
 * unchanged). Multiple verdicts per run are kept (re-judging, model comparison,
 * the eval suite).
 */
export interface AgentVerdict {
  id: string;
  /** The CheckRun this verdict judges (FK → check_runs). */
  runId: string;
  verdict: VerdictKind;
  /** The agent's self-reported confidence, 0..1, or null. */
  confidence: number | null;
  /** Plain-language justification — the agent's reasoning for the verdict. */
  reasoning: string;
  /** Model that produced the verdict (provenance the eval suite slices by). */
  model: string;
  createdAt: Date;
}

/** Fields accepted when recording an AgentVerdict (`id` + `createdAt` are generated). */
export interface AgentVerdictInput {
  runId: string;
  verdict: VerdictKind;
  confidence?: number | null;
  reasoning: string;
  model: string;
}

/** The action recorded for an audit-log row. */
export type AuditAction = "create" | "update" | "delete";

/** One audit-log row: who mutated which entity, when, and the before/after diff. */
export interface AuditLogEntry {
  id: string;
  /** Acting user; null for system actions or a since-removed user. */
  userId: string | null;
  entityType: "project" | "site" | "heartbeat_check" | "uicheck" | "check_group";
  entityId: string;
  action: AuditAction;
  /** `{ before?, after? }` snapshot of the changed fields. */
  diff: AuditDiff;
  createdAt: Date;
}

/** Before/after field snapshot stored on an audit row (serialised to `diff_json`). */
export interface AuditDiff {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

/** Fields accepted when creating a Project. */
export interface ProjectInput {
  name: string;
  contacts?: string;
  slackChannel?: string | null;
  slackWebhookUrl?: string | null;
  alertEmails?: string[];
  retentionDays?: number;
  assignedManagerId?: string | null;
  /** Daily-digest email opt-in (#15). Defaults to true. */
  digestEmailEnabled?: boolean;
  /** Daily-digest Slack opt-in (#15). Defaults to true. */
  digestSlackEnabled?: boolean;
}

/** Fields accepted when updating a Project — every field optional (partial patch). */
export type ProjectPatch = Partial<ProjectInput>;

/** The two flat roles (mirrors auth's `Role`); used to resolve a Project's manager. */
export type UserRole = "admin" | "viewer";

/**
 * A read-only view of a platform user, exposed by config-repo so the worker can
 * resolve a Project's `assignedManagerId` to a digest recipient (#15). config-repo
 * never writes users (auth owns that); it only reads non-deleted rows.
 */
export interface User {
  id: string;
  email: string;
  role: UserRole;
}

/** Fields accepted when creating a Site. */
export interface SiteInput {
  projectId: string;
  baseUrl: string;
}

/** Updatable Site fields (the parent project is fixed once created). */
export interface SitePatch {
  baseUrl?: string;
}

/** The acting user attributed on every mutation's audit-log row. */
export interface Actor {
  id: string | null;
}

/**
 * Low-level persistence for config entities. Dumb CRUD — no validation, no audit:
 * the repo layers those on top. `updatedAt` is set by the store on every write.
 */
export interface ConfigStore {
  projects: {
    list(): Promise<Project[]>;
    get(id: string): Promise<Project | null>;
    insert(project: Project): Promise<Project>;
    update(id: string, patch: ProjectPatch): Promise<Project | null>;
    /** Hard-deletes the project (Sites cascade). Returns the deleted row, or null if absent. */
    remove(id: string): Promise<Project | null>;
  };
  sites: {
    listByProject(projectId: string): Promise<Site[]>;
    get(id: string): Promise<Site | null>;
    insert(site: Site): Promise<Site>;
    update(id: string, patch: SitePatch): Promise<Site | null>;
    remove(id: string): Promise<Site | null>;
  };
  groups: {
    listByProject(projectId: string): Promise<CheckGroup[]>;
    get(id: string): Promise<CheckGroup | null>;
    insert(group: CheckGroup): Promise<CheckGroup>;
    update(id: string, patch: CheckGroupPatch): Promise<CheckGroup | null>;
    /** Hard-deletes the group; member checks' group_id is set null by the caller/FK. Returns the deleted row, or null. */
    remove(id: string): Promise<CheckGroup | null>;
  };
  checks: {
    listBySite(siteId: string): Promise<HeartbeatCheck[]>;
    /** Every heartbeat check across all sites, oldest first. Drives the scheduler tick (#07). */
    listAll(): Promise<HeartbeatCheck[]>;
    get(id: string): Promise<HeartbeatCheck | null>;
    insert(check: HeartbeatCheck): Promise<HeartbeatCheck>;
    update(id: string, patch: HeartbeatCheckPatch): Promise<HeartbeatCheck | null>;
    /** Hard-deletes the check. Returns the deleted row, or null if absent. */
    remove(id: string): Promise<HeartbeatCheck | null>;
  };
  uichecks: {
    listBySite(siteId: string): Promise<UICheck[]>;
    /** Every UI check across all sites, oldest first. Drives the scheduler tick (#14). */
    listAll(): Promise<UICheck[]>;
    get(id: string): Promise<UICheck | null>;
    insert(check: UICheck): Promise<UICheck>;
    update(id: string, patch: UICheckPatch): Promise<UICheck | null>;
    /** Hard-deletes the UI check. Returns the deleted row, or null if absent. */
    remove(id: string): Promise<UICheck | null>;
  };
  checkRuns: {
    insert(run: CheckRun): Promise<CheckRun>;
    /** Runs for one check, newest first, capped at `limit` (default 50). */
    listByCheck(checkId: string, limit?: number): Promise<CheckRun[]>;
    /**
     * Runs for one check within `[from, to)`, oldest first, uncapped — the digest
     * needs a full day, which exceeds `listByCheck`'s 50-row cap (#15).
     */
    listByCheckInWindow(checkId: string, from: Date, to: Date): Promise<CheckRun[]>;
    /**
     * Rewrite one run's `artifacts_ref` (the row is otherwise immutable). Used by
     * the retention reaper to tombstone a run after deleting its artifacts (#17).
     * Returns the updated row, or null if the run is absent.
     */
    setArtifactsRef(runId: string, artifactsRef: string | null): Promise<CheckRun | null>;
    /**
     * The newest `finished_at` across every check_run, or null if none exist —
     * the self-monitoring `/health` last-run-freshness probe (#18).
     */
    latestFinishedAt(): Promise<Date | null>;
  };
  incidents: {
    /** The check's currently-open incident (closed_at is null), or null. At most one. */
    getOpenByCheck(checkId: string): Promise<Incident | null>;
    insert(incident: Incident): Promise<Incident>;
    /** Patch closed_at and/or run_ids (used to close an incident). Returns the row, or null. */
    update(id: string, patch: { closedAt?: Date; runIds?: string[] }): Promise<Incident | null>;
    /** Every incident whose check belongs to the project, newest opened first. */
    listByProject(projectId: string): Promise<Incident[]>;
  };
  verdicts: {
    insert(verdict: AgentVerdict): Promise<AgentVerdict>;
    /** Verdicts for one run, newest first (history / eval). */
    listByRun(runId: string): Promise<AgentVerdict[]>;
    /** The newest verdict for a run, or null — what the run-detail UI shows. */
    latestByRun(runId: string): Promise<AgentVerdict | null>;
  };
  audit: {
    append(entry: AuditLogEntry): Promise<AuditLogEntry>;
    /** All rows, newest first — used by tests and (later) the audit query path. */
    list(): Promise<AuditLogEntry[]>;
  };
  users: {
    /** A non-deleted user by id, or null — read-only manager lookup for the digest (#15). */
    get(id: string): Promise<User | null>;
  };
}
