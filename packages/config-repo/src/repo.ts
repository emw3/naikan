/**
 * `config-repo` — the only DB-access path for Project and Site (PRD deep module 8).
 *
 * The repo is a deep module over a dumb `ConfigStore`: it owns field validation
 * and writes an `AuditLog` row for every successful mutation (create/update/delete),
 * recording the acting user and a before/after diff. Persistence is injected, so the
 * same logic runs against the in-memory store (tests, no-DB dev) and Postgres (prod).
 *
 * Validation throws `ValidationError(field, message)`; the API layer maps it to 400.
 */
import type {
  Actor,
  AgentVerdict,
  AgentVerdictInput,
  AlertRouting,
  AuditAction,
  AuditDiff,
  AuditLogEntry,
  BodyAssertion,
  CheckGroup,
  CheckGroupInput,
  CheckGroupPatch,
  CheckRun,
  CheckRunInput,
  Project,
  ProjectInput,
  ProjectPatch,
  ConfigStore,
  EffectiveHeartbeatCheck,
  EffectiveUICheck,
  HeartbeatCheck,
  HeartbeatCheckInput,
  HeartbeatCheckPatch,
  Incident,
  PerfBudget,
  Severity,
  Site,
  SiteInput,
  SitePatch,
  UICheck,
  UICheckInput,
  UICheckPatch,
  User,
  VerdictKind,
} from "./types.ts";
import { resolveEffectiveCheck, resolveEffectiveUICheck } from "./effective.ts";

/** A field-level validation failure. The `field` names the offending input. */
export class ValidationError extends Error {
  /** The offending input field. */
  readonly field: string;

  // Explicit assignment, not a constructor parameter property — the latter is
  // unsupported by Node's strip-only TS loader, and this kernel is imported by
  // the Node worker (ADR-0005).
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
    this.name = "ValidationError";
  }
}

export interface ConfigRepo {
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  createProject(input: ProjectInput, actor: Actor): Promise<Project>;
  updateProject(id: string, patch: ProjectPatch, actor: Actor): Promise<Project | null>;
  deleteProject(id: string, actor: Actor): Promise<boolean>;

  listSites(projectId: string): Promise<Site[]>;
  getSite(id: string): Promise<Site | null>;
  createSite(input: SiteInput, actor: Actor): Promise<Site>;
  updateSite(id: string, patch: SitePatch, actor: Actor): Promise<Site | null>;
  deleteSite(id: string, actor: Actor): Promise<boolean>;

  listGroups(projectId: string): Promise<CheckGroup[]>;
  getGroup(id: string): Promise<CheckGroup | null>;
  createGroup(input: CheckGroupInput, actor: Actor): Promise<CheckGroup>;
  updateGroup(id: string, patch: CheckGroupPatch, actor: Actor): Promise<CheckGroup | null>;
  deleteGroup(id: string, actor: Actor): Promise<boolean>;

  listChecks(siteId: string): Promise<HeartbeatCheck[]>;
  /** Every heartbeat check across all sites — the scheduler tick's input (#07). */
  listAllChecks(): Promise<HeartbeatCheck[]>;
  getCheck(id: string): Promise<HeartbeatCheck | null>;
  /** A single check with CheckGroup inheritance resolved (never a null interval). */
  getEffectiveCheck(id: string): Promise<EffectiveHeartbeatCheck | null>;
  /** Every check across all sites with inheritance resolved — the scheduler tick's input. */
  listEffectiveChecks(): Promise<EffectiveHeartbeatCheck[]>;
  createCheck(input: HeartbeatCheckInput, actor: Actor): Promise<HeartbeatCheck>;
  updateCheck(id: string, patch: HeartbeatCheckPatch, actor: Actor): Promise<HeartbeatCheck | null>;
  deleteCheck(id: string, actor: Actor): Promise<boolean>;

  /** UI checks under a site (issue #11). */
  listUIChecks(siteId: string): Promise<UICheck[]>;
  /** Every UI check across all sites — the discovery surface the agent enumerates (regression-judge). */
  listAllUIChecks(): Promise<UICheck[]>;
  getUICheck(id: string): Promise<UICheck | null>;
  /** A single UI check with cadence inheritance resolved (never a null interval). (#14) */
  getEffectiveUICheck(id: string): Promise<EffectiveUICheck | null>;
  /** Every UI check across all sites with cadence resolved — the scheduler tick's UI input. (#14) */
  listEffectiveUIChecks(): Promise<EffectiveUICheck[]>;
  createUICheck(input: UICheckInput, actor: Actor): Promise<UICheck>;
  updateUICheck(id: string, patch: UICheckPatch, actor: Actor): Promise<UICheck | null>;
  deleteUICheck(id: string, actor: Actor): Promise<boolean>;
  /**
   * Point a UI check at a freshly-promoted baseline (#12). Sets `baselineImageRef`
   * and writes an audit row recording who promoted it and which run it came from.
   * The artifact copy itself is the caller's job (baseline-store); this only
   * persists the ref + audit. Returns the updated check, or null if absent.
   */
  promoteUICheckBaseline(
    id: string,
    promotion: { baselineImageRef: string; runId: string },
    actor: Actor,
  ): Promise<UICheck | null>;

  /** Persist a CheckRun (operational telemetry — not audited). */
  recordRun(input: CheckRunInput): Promise<CheckRun>;
  /** Runs for a check, newest first (default cap 50). */
  listRuns(checkId: string, limit?: number): Promise<CheckRun[]>;
  /** Runs for a check within `[from, to)`, oldest first, uncapped — the digest window (#15). */
  listRunsInWindow(checkId: string, from: Date, to: Date): Promise<CheckRun[]>;
  /**
   * Rewrite one run's `artifactsRef`. The retention reaper uses this to tombstone
   * a run after deleting its artifacts (#17). Operational telemetry — not audited
   * (like `recordRun`). Returns the updated run, or null if absent.
   */
  setRunArtifactsRef(runId: string, artifactsRef: string | null): Promise<CheckRun | null>;
  /**
   * The newest run timestamp across every check, or null if none — the input to
   * the self-monitoring `/health` last-run-freshness assertion (#18).
   */
  latestRunAt(): Promise<Date | null>;

  /**
   * Record an AI agent's verdict on a UI run's visual diff (Naikan regression-judge,
   * written via `@naikan/mcp`). Validates the verdict kind, a non-empty reasoning +
   * model, and a 0..1 confidence. Agent telemetry — not audited (like `recordRun`).
   */
  recordVerdict(input: AgentVerdictInput): Promise<AgentVerdict>;
  /** The latest agent verdict for a run, or null — what the run-detail UI surfaces. */
  getLatestVerdict(runId: string): Promise<AgentVerdict | null>;
  /** All agent verdicts for a run, newest first (history / eval suite). */
  listVerdicts(runId: string): Promise<AgentVerdict[]>;

  /** The check's open incident (closed_at null), or null. (#09) */
  getOpenIncident(checkId: string): Promise<Incident | null>;
  /** Open a new incident for a check. (#09) */
  openIncident(input: { checkId: string; openedAt: Date; runIds: string[] }): Promise<Incident>;
  /** Close an open incident, recording its closed_at + run span. (#09) */
  closeIncident(id: string, input: { closedAt: Date; runIds: string[] }): Promise<Incident | null>;
  /** Every incident for a project (open + closed), newest opened first. (#09) */
  listProjectIncidents(projectId: string): Promise<Incident[]>;

  /** Audit rows, newest first. (No admin UI in MVP — used by tests + DB queries.) */
  listAudit(): Promise<AuditLogEntry[]>;

  /** A Project's assigned manager (or any user) by id, non-deleted, for digest delivery (#15). */
  getUser(id: string): Promise<User | null>;
}

export interface ConfigRepoDeps {
  /** Clock, injectable for deterministic tests. */
  now?: () => Date;
  /** Id generator, injectable for tests. Defaults to a random UUID. */
  genId?: () => string;
}

const DEFAULT_RETENTION_DAYS = 90;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Slack channel: leading '#', then 1–80 of lowercase letters / digits / . _ -.
const SLACK_RE = /^#[a-z0-9][a-z0-9._-]{0,79}$/;
/** Project fields captured in audit diffs and snapshots. */
const PROJECT_FIELDS = [
  "name",
  "contacts",
  "slackChannel",
  "slackWebhookUrl",
  "alertEmails",
  "retentionDays",
  "assignedManagerId",
  "digestEmailEnabled",
  "digestSlackEnabled",
] as const;
/** HeartbeatCheck fields captured in audit diffs and snapshots. */
const CHECK_FIELDS = [
  "groupId",
  "path",
  "bodyAssertion",
  "certCheck",
  "dnsCheck",
  "intervalSeconds",
  "alertAfterNFails",
] as const;
/** UICheck fields captured in audit diffs and snapshots. */
const UICHECK_FIELDS = [
  "groupId",
  "intervalSeconds",
  "path",
  "viewports",
  "selectors",
  "ignoreRegions",
  "perfBudget",
  "diffThreshold",
  "severityLoad",
  "severityConsole",
  "severitySelector",
  "severityPerf",
  "baselineImageRef",
] as const;
/** The verdict kinds the regression-judge may record (mirrors the DB CHECK constraint). */
const VERDICT_KINDS: readonly VerdictKind[] = ["real_regression", "noise", "intentional", "uncertain"];
/** Canonical viewport labels a UI check may capture at (dimensions live in ui-runner). */
const KNOWN_VIEWPORTS = ["mobile", "tablet", "desktop"] as const;
/** PRD defaults pre-filled on a UI check so an empty submission still works. */
const DEFAULT_VIEWPORTS: string[] = ["mobile", "tablet", "desktop"];
const DEFAULT_PERF_BUDGET: PerfBudget = { lcpMs: 2500, pageWeightBytes: 3 * 1024 * 1024, maxRequests: 100 };
const DEFAULT_DIFF_THRESHOLD = 0.01;
/** CheckGroup fields captured in audit diffs and snapshots. */
const GROUP_FIELDS = [
  "name",
  "defaultIntervalSeconds",
  "defaultAlertRouting",
  "defaultAlertAfterNFails",
] as const;

export function createConfigRepo(store: ConfigStore, deps: ConfigRepoDeps = {}): ConfigRepo {
  const now = deps.now ?? (() => new Date());
  const genId = deps.genId ?? (() => crypto.randomUUID());

  async function audit(
    entityType: AuditLogEntry["entityType"],
    entityId: string,
    action: AuditAction,
    diff: AuditDiff,
    actor: Actor,
  ): Promise<void> {
    await store.audit.append({
      id: genId(),
      userId: actor.id,
      entityType,
      entityId,
      action,
      diff,
      createdAt: now(),
    });
  }

  /** Ensure a check's groupId (when set) names a group owned by the site's project. */
  async function assertGroupMatchesSite(groupId: string | null, siteId: string): Promise<void> {
    if (groupId == null) return;
    const [group, site] = await Promise.all([store.groups.get(groupId), store.sites.get(siteId)]);
    if (!group || !site || group.projectId !== site.projectId) {
      throw new ValidationError("groupId", "Group must belong to the check's project");
    }
  }

  return {
    listProjects: () => store.projects.list(),
    getProject: (id) => store.projects.get(id),

    async createProject(input, actor) {
      const fields = normalizeProjectCreate(input);
      const ts = now();
      const project = await store.projects.insert({
        id: genId(),
        ...fields,
        createdAt: ts,
        updatedAt: ts,
      });
      await audit("project", project.id, "create", { after: snapshot(project, PROJECT_FIELDS) }, actor);
      return project;
    },

    async updateProject(id, patch, actor) {
      const before = await store.projects.get(id);
      if (!before) return null;
      const normalized = normalizeProjectPatch(patch);
      const updated = await store.projects.update(id, normalized);
      if (!updated) return null;
      const diff = diffFields(before, updated, Object.keys(normalized));
      if (diff) await audit("project", id, "update", diff, actor);
      return updated;
    },

    async deleteProject(id, actor) {
      const removed = await store.projects.remove(id);
      if (!removed) return false;
      await audit("project", id, "delete", { before: snapshot(removed, PROJECT_FIELDS) }, actor);
      return true;
    },

    listSites: (projectId) => store.sites.listByProject(projectId),
    getSite: (id) => store.sites.get(id),

    async createSite(input, actor) {
      const baseUrl = normalizeBaseUrl(input.baseUrl);
      if (!input.projectId) throw new ValidationError("projectId", "Project is required");
      const ts = now();
      const site = await store.sites.insert({
        id: genId(),
        projectId: input.projectId,
        baseUrl,
        createdAt: ts,
        updatedAt: ts,
      });
      await audit("site", site.id, "create", { after: snapshot(site, ["baseUrl", "projectId"]) }, actor);
      return site;
    },

    async updateSite(id, patch, actor) {
      const before = await store.sites.get(id);
      if (!before) return null;
      const normalized: SitePatch = {};
      if (patch.baseUrl !== undefined) normalized.baseUrl = normalizeBaseUrl(patch.baseUrl);
      const updated = await store.sites.update(id, normalized);
      if (!updated) return null;
      const diff = diffFields(before, updated, Object.keys(normalized));
      if (diff) await audit("site", id, "update", diff, actor);
      return updated;
    },

    async deleteSite(id, actor) {
      const removed = await store.sites.remove(id);
      if (!removed) return false;
      await audit("site", id, "delete", { before: snapshot(removed, ["baseUrl", "projectId"]) }, actor);
      return true;
    },

    listGroups: (projectId) => store.groups.listByProject(projectId),
    getGroup: (id) => store.groups.get(id),

    async createGroup(input, actor) {
      if (!input.projectId) throw new ValidationError("projectId", "Project is required");
      const fields = normalizeGroupCreate(input);
      const ts = now();
      const group = await store.groups.insert({
        id: genId(),
        projectId: input.projectId,
        ...fields,
        createdAt: ts,
        updatedAt: ts,
      });
      await audit("check_group", group.id, "create", { after: snapshot(group, GROUP_FIELDS) }, actor);
      return group;
    },

    async updateGroup(id, patch, actor) {
      const before = await store.groups.get(id);
      if (!before) return null;
      const normalized = normalizeGroupPatch(patch);
      const updated = await store.groups.update(id, normalized);
      if (!updated) return null;
      const diff = diffFields(before, updated, Object.keys(normalized));
      if (diff) await audit("check_group", id, "update", diff, actor);
      return updated;
    },

    async deleteGroup(id, actor) {
      const removed = await store.groups.remove(id);
      if (!removed) return false;
      await audit("check_group", id, "delete", { before: snapshot(removed, GROUP_FIELDS) }, actor);
      return true;
    },

    listChecks: (siteId) => store.checks.listBySite(siteId),
    listAllChecks: () => store.checks.listAll(),
    getCheck: (id) => store.checks.get(id),

    async getEffectiveCheck(id) {
      const check = await store.checks.get(id);
      if (!check) return null;
      const group = check.groupId ? await store.groups.get(check.groupId) : null;
      return resolveEffectiveCheck(check, group);
    },

    async listEffectiveChecks() {
      const checks = await store.checks.listAll();
      const groupCache = new Map<string, CheckGroup | null>();
      const effective: EffectiveHeartbeatCheck[] = [];
      for (const check of checks) {
        let group: CheckGroup | null = null;
        if (check.groupId) {
          if (!groupCache.has(check.groupId)) {
            groupCache.set(check.groupId, await store.groups.get(check.groupId));
          }
          group = groupCache.get(check.groupId) ?? null;
        }
        effective.push(resolveEffectiveCheck(check, group));
      }
      return effective;
    },

    async createCheck(input, actor) {
      const fields = normalizeCheckCreate(input);
      await assertGroupMatchesSite(fields.groupId, input.siteId);
      const ts = now();
      const check = await store.checks.insert({
        id: genId(),
        siteId: input.siteId,
        ...fields,
        createdAt: ts,
        updatedAt: ts,
      });
      await audit("heartbeat_check", check.id, "create", { after: snapshot(check, CHECK_FIELDS) }, actor);
      return check;
    },

    async updateCheck(id, patch, actor) {
      const before = await store.checks.get(id);
      if (!before) return null;
      const normalized = normalizeCheckPatch(patch);
      if (normalized.groupId !== undefined) {
        await assertGroupMatchesSite(normalized.groupId, before.siteId);
      }
      const updated = await store.checks.update(id, normalized);
      if (!updated) return null;
      const diff = diffFields(before, updated, Object.keys(normalized));
      if (diff) await audit("heartbeat_check", id, "update", diff, actor);
      return updated;
    },

    async deleteCheck(id, actor) {
      const removed = await store.checks.remove(id);
      if (!removed) return false;
      await audit("heartbeat_check", id, "delete", { before: snapshot(removed, CHECK_FIELDS) }, actor);
      return true;
    },

    listUIChecks: (siteId) => store.uichecks.listBySite(siteId),
    listAllUIChecks: () => store.uichecks.listAll(),
    getUICheck: (id) => store.uichecks.get(id),

    async getEffectiveUICheck(id) {
      const check = await store.uichecks.get(id);
      if (!check) return null;
      const group = check.groupId ? await store.groups.get(check.groupId) : null;
      return resolveEffectiveUICheck(check, group);
    },

    async listEffectiveUIChecks() {
      const checks = await store.uichecks.listAll();
      const groupCache = new Map<string, CheckGroup | null>();
      const effective: EffectiveUICheck[] = [];
      for (const check of checks) {
        let group: CheckGroup | null = null;
        if (check.groupId) {
          if (!groupCache.has(check.groupId)) {
            groupCache.set(check.groupId, await store.groups.get(check.groupId));
          }
          group = groupCache.get(check.groupId) ?? null;
        }
        effective.push(resolveEffectiveUICheck(check, group));
      }
      return effective;
    },

    async createUICheck(input, actor) {
      const fields = normalizeUICheckCreate(input);
      await assertGroupMatchesSite(fields.groupId, input.siteId);
      const ts = now();
      const check = await store.uichecks.insert({
        id: genId(),
        siteId: input.siteId,
        ...fields,
        createdAt: ts,
        updatedAt: ts,
      });
      await audit("uicheck", check.id, "create", { after: snapshot(check, UICHECK_FIELDS) }, actor);
      return check;
    },

    async updateUICheck(id, patch, actor) {
      const before = await store.uichecks.get(id);
      if (!before) return null;
      const normalized = normalizeUICheckPatch(patch);
      if (normalized.groupId !== undefined) {
        await assertGroupMatchesSite(normalized.groupId, before.siteId);
      }
      const updated = await store.uichecks.update(id, normalized);
      if (!updated) return null;
      const diff = diffFields(before, updated, Object.keys(normalized));
      if (diff) await audit("uicheck", id, "update", diff, actor);
      return updated;
    },

    async deleteUICheck(id, actor) {
      const removed = await store.uichecks.remove(id);
      if (!removed) return false;
      await audit("uicheck", id, "delete", { before: snapshot(removed, UICHECK_FIELDS) }, actor);
      return true;
    },

    async promoteUICheckBaseline(id, promotion, actor) {
      const before = await store.uichecks.get(id);
      if (!before) return null;
      const updated = await store.uichecks.update(id, {
        baselineImageRef: promotion.baselineImageRef,
      });
      if (!updated) return null;
      // Recorded as an `update` (the audit_log action CHECK only allows
      // create/update/delete), but the diff carries `promotedFromRunId` so the
      // log answers "who promoted which run, and when".
      await audit(
        "uicheck",
        id,
        "update",
        {
          before: { baselineImageRef: before.baselineImageRef },
          after: { baselineImageRef: updated.baselineImageRef, promotedFromRunId: promotion.runId },
        },
        actor,
      );
      return updated;
    },

    recordRun: (input) =>
      store.checkRuns.insert({
        id: genId(),
        checkId: input.checkId,
        checkType: input.checkType,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        status: input.status,
        latencyMs: input.latencyMs,
        error: input.error ?? null,
        artifactsRef: input.artifactsRef ?? null,
        criticalFailed: input.criticalFailed ?? null,
      }),
    listRuns: (checkId, limit) => store.checkRuns.listByCheck(checkId, limit),
    listRunsInWindow: (checkId, from, to) => store.checkRuns.listByCheckInWindow(checkId, from, to),
    setRunArtifactsRef: (runId, artifactsRef) => store.checkRuns.setArtifactsRef(runId, artifactsRef),
    latestRunAt: () => store.checkRuns.latestFinishedAt(),

    // Agent verdicts are operational telemetry — not audited (like recordRun). The
    // repo still validates: an out-of-vocabulary verdict, empty reasoning/model, or
    // an out-of-range confidence is a 400, never a bad row.
    recordVerdict: async (input) => {
      if (!VERDICT_KINDS.includes(input.verdict)) {
        throw new ValidationError("verdict", `Must be one of: ${VERDICT_KINDS.join(", ")}`);
      }
      const reasoning = input.reasoning?.trim();
      if (!reasoning) throw new ValidationError("reasoning", "Reasoning is required");
      const model = input.model?.trim();
      if (!model) throw new ValidationError("model", "Model is required");
      if (input.confidence != null && (input.confidence < 0 || input.confidence > 1)) {
        throw new ValidationError("confidence", "Confidence must be between 0 and 1");
      }
      return store.verdicts.insert({
        id: genId(),
        runId: input.runId,
        verdict: input.verdict,
        confidence: input.confidence ?? null,
        reasoning,
        model,
        createdAt: now(),
      });
    },
    getLatestVerdict: (runId) => store.verdicts.latestByRun(runId),
    listVerdicts: (runId) => store.verdicts.listByRun(runId),

    // Incidents are operational telemetry — not audited (like recordRun).
    getOpenIncident: (checkId) => store.incidents.getOpenByCheck(checkId),
    openIncident: ({ checkId, openedAt, runIds }) =>
      store.incidents.insert({ id: genId(), checkId, openedAt, closedAt: null, runIds }),
    closeIncident: (id, { closedAt, runIds }) => store.incidents.update(id, { closedAt, runIds }),
    listProjectIncidents: (projectId) => store.incidents.listByProject(projectId),

    listAudit: () => store.audit.list(),

    getUser: (id) => store.users.get(id),
  };
}

// ---- validation / normalization ----

/** Validated, defaulted Project fields ready to persist (no id/timestamps). */
type ProjectFields = Omit<Project, "id" | "createdAt" | "updatedAt">;

function normalizeProjectCreate(input: ProjectInput): ProjectFields {
  return {
    name: validateName(input.name),
    contacts: (input.contacts ?? "").trim(),
    slackChannel: normalizeSlack(input.slackChannel),
    slackWebhookUrl: normalizeWebhookUrl(input.slackWebhookUrl),
    alertEmails: validateEmails(input.alertEmails ?? []),
    retentionDays: validateRetention(input.retentionDays ?? DEFAULT_RETENTION_DAYS),
    assignedManagerId: input.assignedManagerId ?? null,
    digestEmailEnabled: input.digestEmailEnabled ?? true,
    digestSlackEnabled: input.digestSlackEnabled ?? true,
  };
}

function normalizeProjectPatch(patch: ProjectPatch): ProjectPatch {
  const out: ProjectPatch = {};
  if (patch.name !== undefined) out.name = validateName(patch.name);
  if (patch.contacts !== undefined) out.contacts = patch.contacts.trim();
  if (patch.slackChannel !== undefined) out.slackChannel = normalizeSlack(patch.slackChannel);
  if (patch.slackWebhookUrl !== undefined) {
    out.slackWebhookUrl = normalizeWebhookUrl(patch.slackWebhookUrl);
  }
  if (patch.alertEmails !== undefined) out.alertEmails = validateEmails(patch.alertEmails);
  if (patch.retentionDays !== undefined) out.retentionDays = validateRetention(patch.retentionDays);
  if (patch.assignedManagerId !== undefined) out.assignedManagerId = patch.assignedManagerId;
  if (patch.digestEmailEnabled !== undefined) out.digestEmailEnabled = patch.digestEmailEnabled;
  if (patch.digestSlackEnabled !== undefined) out.digestSlackEnabled = patch.digestSlackEnabled;
  return out;
}

function validateName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) throw new ValidationError("name", "Name is required");
  return trimmed;
}

function validateRetention(days: number): number {
  if (!Number.isInteger(days) || days <= 0) {
    throw new ValidationError("retentionDays", "Retention days must be a positive whole number");
  }
  return days;
}

function validateEmails(emails: string[]): string[] {
  for (const email of emails) {
    if (!EMAIL_RE.test(email)) {
      throw new ValidationError("alertEmails", `Invalid email address: ${email}`);
    }
  }
  return emails;
}

function normalizeSlack(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!SLACK_RE.test(trimmed)) {
    throw new ValidationError("slackChannel", "Slack channel must look like #channel-name");
  }
  return trimmed;
}

/** A Slack incoming-webhook URL must be a valid https URL; null/empty clears it. */
function normalizeWebhookUrl(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ValidationError("slackWebhookUrl", "Slack webhook must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new ValidationError("slackWebhookUrl", "Slack webhook URL must use https");
  }
  return trimmed;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("baseUrl", "Base URL must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError("baseUrl", "Base URL must use http or https");
  }
  return value.trim();
}

// ---- CheckGroup validation / normalization ----

/** Validated, defaulted CheckGroup fields ready to persist (no id/projectId/timestamps). */
type GroupFields = Omit<CheckGroup, "id" | "projectId" | "createdAt" | "updatedAt">;

function normalizeGroupCreate(input: CheckGroupInput): GroupFields {
  return {
    name: validateName(input.name),
    defaultIntervalSeconds: normalizeNullablePositiveInt(
      "defaultIntervalSeconds",
      input.defaultIntervalSeconds,
    ),
    defaultAlertAfterNFails: normalizeNullablePositiveInt(
      "defaultAlertAfterNFails",
      input.defaultAlertAfterNFails,
    ),
    defaultAlertRouting: normalizeAlertRouting(input.defaultAlertRouting),
  };
}

function normalizeGroupPatch(patch: CheckGroupPatch): CheckGroupPatch {
  const out: CheckGroupPatch = {};
  if (patch.name !== undefined) out.name = validateName(patch.name);
  if (patch.defaultIntervalSeconds !== undefined) {
    out.defaultIntervalSeconds = normalizeNullablePositiveInt(
      "defaultIntervalSeconds",
      patch.defaultIntervalSeconds,
    );
  }
  if (patch.defaultAlertAfterNFails !== undefined) {
    out.defaultAlertAfterNFails = normalizeNullablePositiveInt(
      "defaultAlertAfterNFails",
      patch.defaultAlertAfterNFails,
    );
  }
  if (patch.defaultAlertRouting !== undefined) {
    out.defaultAlertRouting = normalizeAlertRouting(patch.defaultAlertRouting);
  }
  return out;
}

/** Validate routing the same way Project routing is validated; null clears it. */
function normalizeAlertRouting(value: AlertRouting | null | undefined): AlertRouting | null {
  if (value == null) return null;
  return {
    slackChannel: normalizeSlack(value.slackChannel),
    alertEmails: validateEmails(value.alertEmails ?? []),
  };
}

// ---- HeartbeatCheck validation / normalization ----

/** Validated, defaulted HeartbeatCheck fields ready to persist (no id/siteId/timestamps). */
type CheckFields = Omit<HeartbeatCheck, "id" | "siteId" | "createdAt" | "updatedAt">;

function normalizeCheckCreate(input: HeartbeatCheckInput): CheckFields {
  if (!input.siteId) throw new ValidationError("siteId", "Site is required");
  return {
    groupId: input.groupId ?? null,
    path: normalizePath(input.path),
    bodyAssertion: normalizeBodyAssertion(input.bodyAssertion),
    certCheck: input.certCheck ?? false,
    dnsCheck: input.dnsCheck ?? false,
    intervalSeconds: normalizeNullablePositiveInt("intervalSeconds", input.intervalSeconds),
    alertAfterNFails: normalizeNullablePositiveInt("alertAfterNFails", input.alertAfterNFails),
  };
}

function normalizeCheckPatch(patch: HeartbeatCheckPatch): HeartbeatCheckPatch {
  const out: HeartbeatCheckPatch = {};
  if (patch.groupId !== undefined) out.groupId = patch.groupId;
  if (patch.path !== undefined) out.path = normalizePath(patch.path);
  if (patch.bodyAssertion !== undefined) out.bodyAssertion = normalizeBodyAssertion(patch.bodyAssertion);
  if (patch.certCheck !== undefined) out.certCheck = patch.certCheck;
  if (patch.dnsCheck !== undefined) out.dnsCheck = patch.dnsCheck;
  if (patch.intervalSeconds !== undefined) {
    out.intervalSeconds = normalizeNullablePositiveInt("intervalSeconds", patch.intervalSeconds);
  }
  if (patch.alertAfterNFails !== undefined) {
    out.alertAfterNFails = normalizeNullablePositiveInt("alertAfterNFails", patch.alertAfterNFails);
  }
  return out;
}

function normalizePath(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "/";
  if (!trimmed.startsWith("/")) {
    throw new ValidationError("path", "Path must start with /");
  }
  return trimmed;
}

function validatePositiveInt(field: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(field, `${field} must be a positive whole number`);
  }
  return value;
}

/** Like validatePositiveInt, but null/undefined is allowed (means "inherit"). */
function normalizeNullablePositiveInt(
  field: string,
  value: number | null | undefined,
): number | null {
  if (value == null) return null;
  return validatePositiveInt(field, value);
}

function normalizeBodyAssertion(
  value: BodyAssertion | null | undefined,
): BodyAssertion | null {
  if (value == null) return null;
  if (value.kind !== "regex" && value.kind !== "jsonpath") {
    throw new ValidationError("bodyAssertion", "Assertion kind must be regex or jsonpath");
  }
  const pattern = (value.pattern ?? "").trim();
  if (!pattern) throw new ValidationError("bodyAssertion", "Assertion pattern is required");
  if (value.kind === "regex") {
    try {
      new RegExp(pattern);
    } catch {
      throw new ValidationError("bodyAssertion", "Assertion pattern is not a valid regex");
    }
  }
  const out: BodyAssertion = { kind: value.kind, pattern };
  if (value.equals !== undefined) out.equals = value.equals;
  return out;
}

// ---- UICheck validation / normalization ----

/** Validated, defaulted UICheck fields ready to persist (no id/siteId/timestamps). */
type UICheckFields = Omit<UICheck, "id" | "siteId" | "createdAt" | "updatedAt">;

function normalizeUICheckCreate(input: UICheckInput): UICheckFields {
  if (!input.siteId) throw new ValidationError("siteId", "Site is required");
  return {
    groupId: input.groupId ?? null,
    intervalSeconds: normalizeNullablePositiveInt("intervalSeconds", input.intervalSeconds),
    path: normalizePath(input.path),
    viewports: normalizeViewports(input.viewports),
    selectors: normalizeStringList(input.selectors),
    ignoreRegions: normalizeStringList(input.ignoreRegions),
    perfBudget: normalizePerfBudget(input.perfBudget),
    diffThreshold: normalizeDiffThreshold(input.diffThreshold),
    severityLoad: normalizeSeverity("severityLoad", input.severityLoad, "critical"),
    severityConsole: normalizeSeverity("severityConsole", input.severityConsole, "warning"),
    severitySelector: normalizeSeverity("severitySelector", input.severitySelector, "warning"),
    severityPerf: normalizeSeverity("severityPerf", input.severityPerf, "warning"),
    baselineImageRef: input.baselineImageRef ?? null,
  };
}

function normalizeUICheckPatch(patch: UICheckPatch): UICheckPatch {
  const out: UICheckPatch = {};
  if (patch.groupId !== undefined) out.groupId = patch.groupId;
  if (patch.intervalSeconds !== undefined) {
    out.intervalSeconds = normalizeNullablePositiveInt("intervalSeconds", patch.intervalSeconds);
  }
  if (patch.path !== undefined) out.path = normalizePath(patch.path);
  if (patch.viewports !== undefined) out.viewports = normalizeViewports(patch.viewports);
  if (patch.selectors !== undefined) out.selectors = normalizeStringList(patch.selectors);
  if (patch.ignoreRegions !== undefined) out.ignoreRegions = normalizeStringList(patch.ignoreRegions);
  if (patch.perfBudget !== undefined) out.perfBudget = normalizePerfBudget(patch.perfBudget);
  if (patch.diffThreshold !== undefined) out.diffThreshold = normalizeDiffThreshold(patch.diffThreshold);
  if (patch.severityLoad !== undefined) {
    out.severityLoad = normalizeSeverity("severityLoad", patch.severityLoad, "critical");
  }
  if (patch.severityConsole !== undefined) {
    out.severityConsole = normalizeSeverity("severityConsole", patch.severityConsole, "warning");
  }
  if (patch.severitySelector !== undefined) {
    out.severitySelector = normalizeSeverity("severitySelector", patch.severitySelector, "warning");
  }
  if (patch.severityPerf !== undefined) {
    out.severityPerf = normalizeSeverity("severityPerf", patch.severityPerf, "warning");
  }
  if (patch.baselineImageRef !== undefined) out.baselineImageRef = patch.baselineImageRef;
  return out;
}

/** Undefined → PRD default set; otherwise a non-empty subset of the canonical labels. */
function normalizeViewports(value: string[] | undefined): string[] {
  if (value === undefined) return [...DEFAULT_VIEWPORTS];
  if (value.length === 0) {
    throw new ValidationError("viewports", "At least one viewport is required");
  }
  for (const v of value) {
    if (!(KNOWN_VIEWPORTS as readonly string[]).includes(v)) {
      throw new ValidationError("viewports", `Unknown viewport: ${v}`);
    }
  }
  return [...value];
}

/** Trim entries and drop empties; undefined → empty list. */
function normalizeStringList(value: string[] | undefined): string[] {
  if (!value) return [];
  return value.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Merge a partial budget over the PRD defaults; every field must be a positive integer. */
function normalizePerfBudget(value: Partial<PerfBudget> | null | undefined): PerfBudget {
  const merged: PerfBudget = {
    lcpMs: value?.lcpMs ?? DEFAULT_PERF_BUDGET.lcpMs,
    pageWeightBytes: value?.pageWeightBytes ?? DEFAULT_PERF_BUDGET.pageWeightBytes,
    maxRequests: value?.maxRequests ?? DEFAULT_PERF_BUDGET.maxRequests,
  };
  validatePositiveInt("perfBudget", merged.lcpMs);
  validatePositiveInt("perfBudget", merged.pageWeightBytes);
  validatePositiveInt("perfBudget", merged.maxRequests);
  return merged;
}

/** Pixel-diff threshold is a fraction in [0, 1]; undefined → the PRD default. */
function normalizeDiffThreshold(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DIFF_THRESHOLD;
  if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1) {
    throw new ValidationError("diffThreshold", "Diff threshold must be between 0 and 1");
  }
  return value;
}

function normalizeSeverity(field: string, value: Severity | undefined, fallback: Severity): Severity {
  if (value === undefined) return fallback;
  if (value !== "critical" && value !== "warning") {
    throw new ValidationError(field, "Severity must be critical or warning");
  }
  return value;
}

// ---- diff / snapshot helpers ----

function snapshot(row: object, fields: readonly string[]): Record<string, unknown> {
  const r = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = r[f];
  return out;
}

/** Before/after of fields that actually changed; null when nothing changed. */
function diffFields(before: object, after: object, fields: string[]): AuditDiff | null {
  const bf = before as Record<string, unknown>;
  const af = after as Record<string, unknown>;
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const f of fields) {
    if (!equal(bf[f], af[f])) {
      b[f] = bf[f];
      a[f] = af[f];
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

function equal(x: unknown, y: unknown): boolean {
  if (Array.isArray(x) && Array.isArray(y)) {
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  return x === y;
}
