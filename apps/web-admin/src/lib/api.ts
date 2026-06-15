/** Typed project for the auth + users API. All calls are same-origin (the API serves this SPA). */

export type Role = "admin" | "viewer";

export interface User {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
}

/** Carries a user-facing message + HTTP status for the UI to render. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Offending input field on a 400 validation error, when the API names one. */
    readonly field?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function errorFrom(res: Response, fallback: string): Promise<ApiError> {
  let message = fallback;
  let field: string | undefined;
  try {
    const body = (await res.json()) as { error?: unknown; field?: unknown };
    if (typeof body.error === "string") message = body.error;
    if (typeof body.field === "string") field = body.field;
  } catch {
    // non-JSON body; keep the fallback
  }
  return new ApiError(message, res.status, field);
}

const JSON_HEADERS = { "content-type": "application/json" };

/** Current session's user, or null if not logged in (401). */
export async function me(): Promise<User | null> {
  const res = await fetch("/api/auth/me");
  if (res.status === 401) return null;
  if (!res.ok) throw await errorFrom(res, "Could not load your session");
  return ((await res.json()) as { user: User }).user;
}

export async function login(email: string, password: string): Promise<User> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password }),
  });
  if (res.status === 401) throw new ApiError("Invalid email or password", 401);
  if (!res.ok) throw await errorFrom(res, "Sign in failed");
  return ((await res.json()) as { user: User }).user;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}

export async function listUsers(): Promise<User[]> {
  const res = await fetch("/api/users");
  if (!res.ok) throw await errorFrom(res, "Could not load users");
  return ((await res.json()) as { users: User[] }).users;
}

export async function createUser(input: {
  email: string;
  password: string;
  role: Role;
}): Promise<User> {
  const res = await fetch("/api/users", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFrom(res, "Could not create user");
  return ((await res.json()) as { user: User }).user;
}

export async function changeRole(id: string, role: Role): Promise<User> {
  const res = await fetch(`/api/users/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ role }),
  });
  if (!res.ok) throw await errorFrom(res, "Could not change role");
  return ((await res.json()) as { user: User }).user;
}

export async function deleteUser(id: string): Promise<void> {
  const res = await fetch(`/api/users/${id}`, { method: "DELETE" });
  if (!res.ok) throw await errorFrom(res, "Could not remove user");
}

// ---- Projects + Sites (issue #05) ----

export interface Project {
  id: string;
  name: string;
  contacts: string;
  slackChannel: string | null;
  slackWebhookUrl: string | null;
  alertEmails: string[];
  retentionDays: number;
  assignedManagerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Site {
  id: string;
  projectId: string;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
}

/** Fields a create/edit project form submits. Omitted fields fall back to defaults. */
export interface ProjectInput {
  name: string;
  contacts: string;
  slackChannel: string | null;
  slackWebhookUrl: string | null;
  alertEmails: string[];
  retentionDays: number;
  assignedManagerId: string | null;
}

export async function listProjects(): Promise<Project[]> {
  const res = await fetch("/api/projects");
  if (!res.ok) throw await errorFrom(res, "Could not load projects");
  return ((await res.json()) as { projects: Project[] }).projects;
}

export async function getProject(id: string): Promise<Project> {
  const res = await fetch(`/api/projects/${id}`);
  if (!res.ok) throw await errorFrom(res, "Could not load project");
  return ((await res.json()) as { project: Project }).project;
}

export async function createProject(input: ProjectInput): Promise<Project> {
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFrom(res, "Could not create project");
  return ((await res.json()) as { project: Project }).project;
}

export async function updateProject(id: string, patch: Partial<ProjectInput>): Promise<Project> {
  const res = await fetch(`/api/projects/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await errorFrom(res, "Could not save project");
  return ((await res.json()) as { project: Project }).project;
}

export async function deleteProject(id: string): Promise<void> {
  const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
  if (!res.ok) throw await errorFrom(res, "Could not delete project");
}

export async function listSites(projectId: string): Promise<Site[]> {
  const res = await fetch(`/api/projects/${projectId}/sites`);
  if (!res.ok) throw await errorFrom(res, "Could not load sites");
  return ((await res.json()) as { sites: Site[] }).sites;
}

export async function getSite(id: string): Promise<Site> {
  const res = await fetch(`/api/sites/${id}`);
  if (!res.ok) throw await errorFrom(res, "Could not load site");
  return ((await res.json()) as { site: Site }).site;
}

export async function createSite(projectId: string, baseUrl: string): Promise<Site> {
  const res = await fetch(`/api/projects/${projectId}/sites`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ baseUrl }),
  });
  if (!res.ok) throw await errorFrom(res, "Could not add site");
  return ((await res.json()) as { site: Site }).site;
}

export async function updateSite(id: string, baseUrl: string): Promise<Site> {
  const res = await fetch(`/api/sites/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ baseUrl }),
  });
  if (!res.ok) throw await errorFrom(res, "Could not save site");
  return ((await res.json()) as { site: Site }).site;
}

export async function deleteSite(id: string): Promise<void> {
  const res = await fetch(`/api/sites/${id}`, { method: "DELETE" });
  if (!res.ok) throw await errorFrom(res, "Could not remove site");
}

// ---- Heartbeat checks + runs (issue #06) ----

export interface BodyAssertion {
  kind: "regex" | "jsonpath";
  pattern: string;
  equals?: string;
}

export interface HeartbeatCheck {
  id: string;
  siteId: string;
  groupId: string | null;
  path: string;
  bodyAssertion: BodyAssertion | null;
  certCheck: boolean;
  dnsCheck: boolean;
  intervalSeconds: number | null;
  alertAfterNFails: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Fields a create/edit check form submits. Null interval/alertAfterNFails = inherit from the group. */
export interface HeartbeatCheckInput {
  groupId: string | null;
  path: string;
  bodyAssertion: BodyAssertion | null;
  certCheck: boolean;
  dnsCheck: boolean;
  intervalSeconds: number | null;
  alertAfterNFails: number | null;
}

export interface CheckRun {
  id: string;
  checkId: string;
  checkType: "heartbeat" | "uicheck";
  startedAt: string;
  finishedAt: string;
  status: "pass" | "fail";
  latencyMs: number;
  error: string | null;
  artifactsRef: string | null;
}

export async function listChecks(siteId: string): Promise<HeartbeatCheck[]> {
  const res = await fetch(`/api/sites/${siteId}/checks`);
  if (!res.ok) throw await errorFrom(res, "Could not load checks");
  return ((await res.json()) as { checks: HeartbeatCheck[] }).checks;
}

export async function createCheck(
  siteId: string,
  input: HeartbeatCheckInput,
): Promise<HeartbeatCheck> {
  const res = await fetch(`/api/sites/${siteId}/checks`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFrom(res, "Could not create check");
  return ((await res.json()) as { check: HeartbeatCheck }).check;
}

export async function updateCheck(
  id: string,
  patch: Partial<HeartbeatCheckInput>,
): Promise<HeartbeatCheck> {
  const res = await fetch(`/api/checks/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await errorFrom(res, "Could not save check");
  return ((await res.json()) as { check: HeartbeatCheck }).check;
}

export async function deleteCheck(id: string): Promise<void> {
  const res = await fetch(`/api/checks/${id}`, { method: "DELETE" });
  if (!res.ok) throw await errorFrom(res, "Could not delete check");
}

/** Runs a check synchronously and returns the recorded CheckRun. */
export async function runCheck(id: string): Promise<CheckRun> {
  const res = await fetch(`/api/checks/${id}/run`, { method: "POST" });
  if (!res.ok) throw await errorFrom(res, "Could not run check");
  return ((await res.json()) as { run: CheckRun }).run;
}

export async function listRuns(id: string): Promise<CheckRun[]> {
  const res = await fetch(`/api/checks/${id}/runs`);
  if (!res.ok) throw await errorFrom(res, "Could not load runs");
  return ((await res.json()) as { runs: CheckRun[] }).runs;
}

// ---- Check groups (issue #08) ----

export interface AlertRouting {
  slackChannel: string | null;
  alertEmails: string[];
}

export interface CheckGroup {
  id: string;
  projectId: string;
  name: string;
  defaultIntervalSeconds: number | null;
  defaultAlertRouting: AlertRouting | null;
  defaultAlertAfterNFails: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Fields a create/edit group form submits. */
export interface CheckGroupInput {
  name: string;
  defaultIntervalSeconds: number | null;
  defaultAlertRouting: AlertRouting | null;
  defaultAlertAfterNFails: number | null;
}

export async function listGroups(projectId: string): Promise<CheckGroup[]> {
  const res = await fetch(`/api/projects/${projectId}/groups`);
  if (!res.ok) throw await errorFrom(res, "Could not load check groups");
  return ((await res.json()) as { groups: CheckGroup[] }).groups;
}

export async function createGroup(projectId: string, input: CheckGroupInput): Promise<CheckGroup> {
  const res = await fetch(`/api/projects/${projectId}/groups`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFrom(res, "Could not create check group");
  return ((await res.json()) as { group: CheckGroup }).group;
}

export async function updateGroup(id: string, patch: Partial<CheckGroupInput>): Promise<CheckGroup> {
  const res = await fetch(`/api/groups/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await errorFrom(res, "Could not save check group");
  return ((await res.json()) as { group: CheckGroup }).group;
}

export async function deleteGroup(id: string): Promise<void> {
  const res = await fetch(`/api/groups/${id}`, { method: "DELETE" });
  if (!res.ok) throw await errorFrom(res, "Could not delete check group");
}

// ---- Incidents (issue #09) ----

export interface Incident {
  id: string;
  checkId: string;
  openedAt: string;
  closedAt: string | null;
  runIds: string[];
}

/** Open + closed incidents for a project (newest first). */
export async function getProjectIncidents(
  projectId: string,
): Promise<{ open: Incident[]; closed: Incident[] }> {
  const res = await fetch(`/api/projects/${projectId}/incidents`);
  if (!res.ok) throw await errorFrom(res, "Could not load incidents");
  return (await res.json()) as { open: Incident[]; closed: Incident[] };
}

// ---- UI checks + runs (issue #11b) ----

export type Severity = "critical" | "warning";

export interface PerfBudget {
  lcpMs: number;
  pageWeightBytes: number;
  maxRequests: number;
}

export interface UICheck {
  id: string;
  siteId: string;
  groupId: string | null;
  path: string;
  viewports: string[];
  selectors: string[];
  ignoreRegions: string[];
  perfBudget: PerfBudget;
  diffThreshold: number;
  severityLoad: Severity;
  severityConsole: Severity;
  severitySelector: Severity;
  severityPerf: Severity;
  baselineImageRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Fields a create/edit UI-check form submits. */
export interface UICheckInput {
  groupId: string | null;
  path: string;
  viewports: string[];
  selectors: string[];
  ignoreRegions: string[];
  perfBudget: PerfBudget;
  diffThreshold: number;
  severityLoad: Severity;
  severityConsole: Severity;
  severitySelector: Severity;
  severityPerf: Severity;
}

/** One viewport's diff: the differing-pixel fraction + a presigned overlay URL (null on a dimension mismatch). */
export interface UIRunDiff {
  pct: number;
  url: string | null;
}

/** One judged synthetic signal for a viewport (#13). */
export type SignalKind = "load" | "console" | "selector" | "perf";
export interface UISignal {
  kind: SignalKind;
  pass: boolean;
  severity: Severity;
  detail: string;
}

/** The four verdict kinds the regression-judge agent can record (single source of truth: the DB CHECK + repo). */
export type VerdictKind = "real_regression" | "noise" | "intentional" | "uncertain";

/**
 * An AI agent's regression-judge verdict on a UI run's diff, recorded over the
 * `@naikan/mcp` server. Advisory telemetry: the run-detail view surfaces it as a
 * badge next to the human promote-to-baseline action, which is unchanged.
 */
export interface AgentVerdict {
  id: string;
  runId: string;
  verdict: VerdictKind;
  /** Agent's self-reported confidence, 0..1, or null. */
  confidence: number | null;
  /** Plain-language justification for the verdict. */
  reasoning: string;
  /** Model that produced the verdict (provenance). */
  model: string;
  /** ISO timestamp (serialised from the API's Date). */
  createdAt: string;
}

/**
 * A run plus presigned URLs keyed by viewport: the run's own `screenshots`, the
 * per-viewport `diffs` (#12), the check's current approved `baseline` — so the UI
 * can render baseline | current | diff side by side — and the per-viewport judged
 * `signals` (#13).
 */
export interface UIRunDetail {
  run: CheckRun;
  screenshots: Record<string, string>;
  diffs: Record<string, UIRunDiff>;
  baseline: Record<string, string>;
  signals: Record<string, UISignal[]>;
  /** True once the retention reaper has deleted this run's artifacts (#17). */
  expired: boolean;
  /** The latest agent regression-judge verdict for this run, or null if none recorded. */
  verdict: AgentVerdict | null;
}

export async function listUIChecks(siteId: string): Promise<UICheck[]> {
  const res = await fetch(`/api/sites/${siteId}/uichecks`);
  if (!res.ok) throw await errorFrom(res, "Could not load UI checks");
  return ((await res.json()) as { checks: UICheck[] }).checks;
}

export async function getUICheck(id: string): Promise<UICheck> {
  const res = await fetch(`/api/uichecks/${id}`);
  if (!res.ok) throw await errorFrom(res, "Could not load UI check");
  return ((await res.json()) as { check: UICheck }).check;
}

export async function createUICheck(siteId: string, input: UICheckInput): Promise<UICheck> {
  const res = await fetch(`/api/sites/${siteId}/uichecks`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await errorFrom(res, "Could not create UI check");
  return ((await res.json()) as { check: UICheck }).check;
}

export async function updateUICheck(id: string, patch: Partial<UICheckInput>): Promise<UICheck> {
  const res = await fetch(`/api/uichecks/${id}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await errorFrom(res, "Could not save UI check");
  return ((await res.json()) as { check: UICheck }).check;
}

export async function deleteUICheck(id: string): Promise<void> {
  const res = await fetch(`/api/uichecks/${id}`, { method: "DELETE" });
  if (!res.ok) throw await errorFrom(res, "Could not delete UI check");
}

/** Enqueues a UI-check run on the worker queue (does not run inline). Resolves once queued. */
export async function runUICheck(id: string): Promise<void> {
  const res = await fetch(`/api/uichecks/${id}/run`, { method: "POST" });
  if (!res.ok) throw await errorFrom(res, "Could not queue UI check run");
}

export async function listUIRuns(id: string): Promise<CheckRun[]> {
  const res = await fetch(`/api/uichecks/${id}/runs`);
  if (!res.ok) throw await errorFrom(res, "Could not load runs");
  return ((await res.json()) as { runs: CheckRun[] }).runs;
}

export async function getUIRun(checkId: string, runId: string): Promise<UIRunDetail> {
  const res = await fetch(`/api/uichecks/${checkId}/runs/${runId}`);
  if (!res.ok) throw await errorFrom(res, "Could not load run");
  return (await res.json()) as UIRunDetail;
}

/** Promote a run's screenshots to the check's approved baseline (#12). Admin-only. */
export async function promoteUIRun(checkId: string, runId: string): Promise<UICheck> {
  const res = await fetch(`/api/uichecks/${checkId}/runs/${runId}/promote`, { method: "POST" });
  if (!res.ok) throw await errorFrom(res, "Could not promote run to baseline");
  return ((await res.json()) as { check: UICheck }).check;
}

// ---- Read-only dashboard detail views (issue #16) ----

/** The badge a check shows: an open incident dominates, else the last run's verdict. */
export type CheckState = "ok" | "failing" | "incident" | "unknown";

/** Pass/fail tally over a run set. */
export interface RunSummary {
  pass: number;
  fail: number;
  total: number;
}

/** One check on the project overview, with its last-24h tally + current state. */
export interface OverviewCheck {
  id: string;
  kind: "heartbeat" | "uicheck";
  siteId: string;
  host: string;
  path: string;
  state: CheckState;
  last24h: RunSummary;
  openIncident: boolean;
}

/** Project overview: every check under the project + an open-incident count. */
export interface ProjectOverview {
  project: Project;
  openIncidentCount: number;
  checks: OverviewCheck[];
}

/** Heartbeat check detail: 24h timeline + recent incidents + current state. */
export interface HeartbeatDetail {
  check: HeartbeatCheck;
  projectId: string;
  host: string;
  state: CheckState;
  last24h: RunSummary;
  /** Runs within the last 24h, oldest-first (a left-to-right timeline). */
  timeline: CheckRun[];
  recentIncidents: Incident[];
}

/** UI check detail metadata (the runs/signals themselves come from the #11b routes). */
export interface UICheckMeta {
  check: UICheck;
  projectId: string;
  host: string;
  state: CheckState;
  recentIncidents: Incident[];
}

/** One incident on the cross-project incidents view. */
export interface IncidentRow {
  id: string;
  checkId: string;
  checkType: "heartbeat" | "uicheck" | null;
  checkLabel: string;
  projectId: string;
  projectName: string;
  openedAt: string;
  closedAt: string | null;
  durationMs: number;
  open: boolean;
}

export async function getProjectOverview(projectId: string): Promise<ProjectOverview> {
  const res = await fetch(`/api/projects/${projectId}/overview`);
  if (!res.ok) throw await errorFrom(res, "Could not load project overview");
  return (await res.json()) as ProjectOverview;
}

export async function getHeartbeatDetail(checkId: string): Promise<HeartbeatDetail> {
  const res = await fetch(`/api/checks/${checkId}/detail`);
  if (!res.ok) throw await errorFrom(res, "Could not load check detail");
  return (await res.json()) as HeartbeatDetail;
}

export async function getUICheckMeta(checkId: string): Promise<UICheckMeta> {
  const res = await fetch(`/api/uichecks/${checkId}/detail`);
  if (!res.ok) throw await errorFrom(res, "Could not load UI check detail");
  return (await res.json()) as UICheckMeta;
}

/** Incidents across the user's projects, filtered by open (default) or closed. */
export async function listIncidents(status: "open" | "closed" = "open"): Promise<IncidentRow[]> {
  const res = await fetch(`/api/incidents?status=${status}`);
  if (!res.ok) throw await errorFrom(res, "Could not load incidents");
  return ((await res.json()) as { incidents: IncidentRow[] }).incidents;
}
