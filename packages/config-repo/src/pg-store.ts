/**
 * Postgres-backed `ConfigStore`, wiring the repo to the `projects` / `sites` /
 * `audit_log` tables in production. Behaviour mirrors `InMemoryConfigStore` (which
 * the repo tests pin): same ordering, same row shapes, `updated_at` stamped on
 * every update, Sites cascade with their Project via the FK.
 *
 * The project is supplied as a getter (`() => Sql`) so it stays lazy — no Postgres
 * connection opens until the first config query runs (the issue #01 boot-without-DB
 * property). Raw SQL, no ORM (PRD).
 */
import type postgres from "postgres";
import type {
  AgentVerdict,
  AlertRouting,
  AuditLogEntry,
  BodyAssertion,
  CheckGroup,
  CheckGroupPatch,
  CheckRun,
  Project,
  ProjectPatch,
  ConfigStore,
  HeartbeatCheck,
  HeartbeatCheckPatch,
  Incident,
  PerfBudget,
  Site,
  UICheck,
  UICheckPatch,
  User,
} from "./types.ts";

type Sql = ReturnType<typeof postgres>;

interface ProjectRow {
  id: string;
  name: string;
  contacts: string;
  slack_channel: string | null;
  slack_webhook_url: string | null;
  alert_emails: string[];
  retention_days: number;
  assigned_manager_id: string | null;
  digest_email_enabled: boolean;
  digest_slack_enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

interface SiteRow {
  id: string;
  project_id: string;
  base_url: string;
  created_at: Date;
  updated_at: Date;
}

interface CheckRow {
  id: string;
  site_id: string;
  group_id: string | null;
  path: string;
  body_assertion: BodyAssertion | null;
  cert_check: boolean;
  dns_check: boolean;
  interval_seconds: number | null;
  alert_after_n_fails: number | null;
  created_at: Date;
  updated_at: Date;
}

interface UICheckRow {
  id: string;
  site_id: string;
  group_id: string | null;
  interval_seconds: number | null;
  path: string;
  viewports: string[];
  selectors: string[];
  ignore_regions: string[];
  perf_budget: PerfBudget;
  diff_threshold: number;
  severity_load: UICheck["severityLoad"];
  severity_console: UICheck["severityConsole"];
  severity_selector: UICheck["severitySelector"];
  severity_perf: UICheck["severityPerf"];
  baseline_image_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

interface CheckGroupRow {
  id: string;
  project_id: string;
  name: string;
  default_interval_seconds: number | null;
  default_alert_routing: AlertRouting | null;
  default_alert_after_n_fails: number | null;
  created_at: Date;
  updated_at: Date;
}

interface CheckRunRow {
  id: string;
  check_id: string;
  check_type: CheckRun["checkType"];
  started_at: Date;
  finished_at: Date;
  status: CheckRun["status"];
  latency_ms: number;
  error: string | null;
  artifacts_ref: string | null;
  critical_failed: boolean | null;
}

interface IncidentRow {
  id: string;
  check_id: string;
  opened_at: Date;
  closed_at: Date | null;
  run_ids: string[];
}

interface AgentVerdictRow {
  id: string;
  run_id: string;
  verdict: AgentVerdict["verdict"];
  confidence: number | null;
  reasoning: string;
  model: string;
  created_at: Date;
}

interface AuditRow {
  id: string;
  user_id: string | null;
  entity_type: AuditLogEntry["entityType"];
  entity_id: string;
  action: AuditLogEntry["action"];
  diff_json: AuditLogEntry["diff"];
  created_at: Date;
}

interface UserRow {
  id: string;
  email: string;
  role: User["role"];
}

function toUser(r: UserRow): User {
  return { id: r.id, email: r.email, role: r.role };
}

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    contacts: r.contacts,
    slackChannel: r.slack_channel,
    slackWebhookUrl: r.slack_webhook_url,
    alertEmails: r.alert_emails,
    retentionDays: r.retention_days,
    assignedManagerId: r.assigned_manager_id,
    digestEmailEnabled: r.digest_email_enabled,
    digestSlackEnabled: r.digest_slack_enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toSite(r: SiteRow): Site {
  return {
    id: r.id,
    projectId: r.project_id,
    baseUrl: r.base_url,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toCheck(r: CheckRow): HeartbeatCheck {
  return {
    id: r.id,
    siteId: r.site_id,
    groupId: r.group_id,
    path: r.path,
    bodyAssertion: r.body_assertion,
    certCheck: r.cert_check,
    dnsCheck: r.dns_check,
    intervalSeconds: r.interval_seconds,
    alertAfterNFails: r.alert_after_n_fails,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toUICheck(r: UICheckRow): UICheck {
  return {
    id: r.id,
    siteId: r.site_id,
    groupId: r.group_id,
    intervalSeconds: r.interval_seconds,
    path: r.path,
    viewports: r.viewports,
    selectors: r.selectors,
    ignoreRegions: r.ignore_regions,
    perfBudget: r.perf_budget,
    diffThreshold: r.diff_threshold,
    severityLoad: r.severity_load,
    severityConsole: r.severity_console,
    severitySelector: r.severity_selector,
    severityPerf: r.severity_perf,
    baselineImageRef: r.baseline_image_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toGroup(r: CheckGroupRow): CheckGroup {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    defaultIntervalSeconds: r.default_interval_seconds,
    defaultAlertRouting: r.default_alert_routing,
    defaultAlertAfterNFails: r.default_alert_after_n_fails,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toCheckRun(r: CheckRunRow): CheckRun {
  return {
    id: r.id,
    checkId: r.check_id,
    checkType: r.check_type,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    latencyMs: r.latency_ms,
    error: r.error,
    artifactsRef: r.artifacts_ref,
    criticalFailed: r.critical_failed,
  };
}

function toIncident(r: IncidentRow): Incident {
  return {
    id: r.id,
    checkId: r.check_id,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    runIds: r.run_ids,
  };
}

function toAgentVerdict(r: AgentVerdictRow): AgentVerdict {
  return {
    id: r.id,
    runId: r.run_id,
    verdict: r.verdict,
    confidence: r.confidence,
    reasoning: r.reasoning,
    model: r.model,
    createdAt: r.created_at,
  };
}

function toAudit(r: AuditRow): AuditLogEntry {
  return {
    id: r.id,
    userId: r.user_id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    action: r.action,
    diff: r.diff_json,
    createdAt: r.created_at,
  };
}

export function createPgConfigStore(getSql: () => Sql): ConfigStore {
  return {
    projects: {
      async list() {
        const sql = getSql();
        const rows = await sql<ProjectRow[]>`select * from projects order by created_at`;
        return rows.map(toProject);
      },

      async get(id) {
        const sql = getSql();
        const rows = await sql<ProjectRow[]>`select * from projects where id = ${id} limit 1`;
        return rows[0] ? toProject(rows[0]) : null;
      },

      async insert(project) {
        const sql = getSql();
        const rows = await sql<ProjectRow[]>`
          insert into projects
            (id, name, contacts, slack_channel, slack_webhook_url, alert_emails, retention_days,
             assigned_manager_id, digest_email_enabled, digest_slack_enabled, created_at, updated_at)
          values
            (${project.id}, ${project.name}, ${project.contacts}, ${project.slackChannel}, ${project.slackWebhookUrl},
             ${project.alertEmails}, ${project.retentionDays}, ${project.assignedManagerId},
             ${project.digestEmailEnabled}, ${project.digestSlackEnabled},
             ${project.createdAt}, ${project.updatedAt})
          returning *`;
        return toProject(rows[0]!);
      },

      async update(id, patch) {
        const sql = getSql();
        const row = projectPatchRow(patch);
        // No real columns to set — just touch updated_at (avoids an empty `set`).
        const rows = Object.keys(row).length
          ? await sql<ProjectRow[]>`
              update projects set ${sql(row)}, updated_at = now() where id = ${id} returning *`
          : await sql<ProjectRow[]>`
              update projects set updated_at = now() where id = ${id} returning *`;
        return rows[0] ? toProject(rows[0]) : null;
      },

      async remove(id) {
        const sql = getSql();
        const rows = await sql<ProjectRow[]>`delete from projects where id = ${id} returning *`;
        return rows[0] ? toProject(rows[0]) : null;
      },
    },

    sites: {
      async listByProject(projectId) {
        const sql = getSql();
        const rows = await sql<SiteRow[]>`
          select * from sites where project_id = ${projectId} order by created_at`;
        return rows.map(toSite);
      },

      async get(id) {
        const sql = getSql();
        const rows = await sql<SiteRow[]>`select * from sites where id = ${id} limit 1`;
        return rows[0] ? toSite(rows[0]) : null;
      },

      async insert(site) {
        const sql = getSql();
        const rows = await sql<SiteRow[]>`
          insert into sites (id, project_id, base_url, created_at, updated_at)
          values (${site.id}, ${site.projectId}, ${site.baseUrl}, ${site.createdAt}, ${site.updatedAt})
          returning *`;
        return toSite(rows[0]!);
      },

      async update(id, patch) {
        const sql = getSql();
        // baseUrl is the only updatable field; skip the write if absent.
        if (patch.baseUrl === undefined) return this.get(id);
        const rows = await sql<SiteRow[]>`
          update sites set base_url = ${patch.baseUrl}, updated_at = now()
          where id = ${id}
          returning *`;
        return rows[0] ? toSite(rows[0]) : null;
      },

      async remove(id) {
        const sql = getSql();
        const rows = await sql<SiteRow[]>`delete from sites where id = ${id} returning *`;
        return rows[0] ? toSite(rows[0]) : null;
      },
    },

    groups: {
      async listByProject(projectId) {
        const sql = getSql();
        const rows = await sql<CheckGroupRow[]>`
          select * from check_groups where project_id = ${projectId} order by created_at`;
        return rows.map(toGroup);
      },

      async get(id) {
        const sql = getSql();
        const rows = await sql<CheckGroupRow[]>`select * from check_groups where id = ${id} limit 1`;
        return rows[0] ? toGroup(rows[0]) : null;
      },

      async insert(group) {
        const sql = getSql();
        const rows = await sql<CheckGroupRow[]>`
          insert into check_groups
            (id, project_id, name, default_interval_seconds, default_alert_routing,
             default_alert_after_n_fails, created_at, updated_at)
          values
            (${group.id}, ${group.projectId}, ${group.name}, ${group.defaultIntervalSeconds},
             ${group.defaultAlertRouting ? sql.json(group.defaultAlertRouting as unknown as Parameters<typeof sql.json>[0]) : null},
             ${group.defaultAlertAfterNFails}, ${group.createdAt}, ${group.updatedAt})
          returning *`;
        return toGroup(rows[0]!);
      },

      async update(id, patch) {
        const sql = getSql();
        const row = groupPatchRow(sql, patch);
        const rows = Object.keys(row).length
          ? await sql<CheckGroupRow[]>`
              update check_groups set ${sql(row)}, updated_at = now() where id = ${id} returning *`
          : await sql<CheckGroupRow[]>`
              update check_groups set updated_at = now() where id = ${id} returning *`;
        return rows[0] ? toGroup(rows[0]) : null;
      },

      async remove(id) {
        const sql = getSql();
        const rows = await sql<CheckGroupRow[]>`delete from check_groups where id = ${id} returning *`;
        return rows[0] ? toGroup(rows[0]) : null;
      },
    },

    checks: {
      async listBySite(siteId) {
        const sql = getSql();
        const rows = await sql<CheckRow[]>`
          select * from heartbeat_checks where site_id = ${siteId} order by created_at`;
        return rows.map(toCheck);
      },

      async listAll() {
        const sql = getSql();
        const rows = await sql<CheckRow[]>`select * from heartbeat_checks order by created_at`;
        return rows.map(toCheck);
      },

      async get(id) {
        const sql = getSql();
        const rows = await sql<CheckRow[]>`select * from heartbeat_checks where id = ${id} limit 1`;
        return rows[0] ? toCheck(rows[0]) : null;
      },

      async insert(check) {
        const sql = getSql();
        const rows = await sql<CheckRow[]>`
          insert into heartbeat_checks
            (id, site_id, group_id, path, body_assertion, cert_check, dns_check,
             interval_seconds, alert_after_n_fails, created_at, updated_at)
          values
            (${check.id}, ${check.siteId}, ${check.groupId}, ${check.path},
             ${check.bodyAssertion ? sql.json(check.bodyAssertion as unknown as Parameters<typeof sql.json>[0]) : null},
             ${check.certCheck}, ${check.dnsCheck}, ${check.intervalSeconds},
             ${check.alertAfterNFails}, ${check.createdAt}, ${check.updatedAt})
          returning *`;
        return toCheck(rows[0]!);
      },

      async update(id, patch) {
        const sql = getSql();
        const row = checkPatchRow(sql, patch);
        const rows = Object.keys(row).length
          ? await sql<CheckRow[]>`
              update heartbeat_checks set ${sql(row)}, updated_at = now() where id = ${id} returning *`
          : await sql<CheckRow[]>`
              update heartbeat_checks set updated_at = now() where id = ${id} returning *`;
        return rows[0] ? toCheck(rows[0]) : null;
      },

      async remove(id) {
        const sql = getSql();
        const rows = await sql<CheckRow[]>`delete from heartbeat_checks where id = ${id} returning *`;
        return rows[0] ? toCheck(rows[0]) : null;
      },
    },

    uichecks: {
      async listBySite(siteId) {
        const sql = getSql();
        const rows = await sql<UICheckRow[]>`
          select * from ui_checks where site_id = ${siteId} order by created_at`;
        return rows.map(toUICheck);
      },

      async listAll() {
        const sql = getSql();
        const rows = await sql<UICheckRow[]>`select * from ui_checks order by created_at`;
        return rows.map(toUICheck);
      },

      async get(id) {
        const sql = getSql();
        const rows = await sql<UICheckRow[]>`select * from ui_checks where id = ${id} limit 1`;
        return rows[0] ? toUICheck(rows[0]) : null;
      },

      async insert(check) {
        const sql = getSql();
        const rows = await sql<UICheckRow[]>`
          insert into ui_checks
            (id, site_id, group_id, interval_seconds, path, viewports, selectors, ignore_regions,
             perf_budget, diff_threshold, severity_load, severity_console, severity_selector,
             severity_perf, baseline_image_ref, created_at, updated_at)
          values
            (${check.id}, ${check.siteId}, ${check.groupId}, ${check.intervalSeconds}, ${check.path},
             ${check.viewports}, ${check.selectors}, ${check.ignoreRegions},
             ${sql.json(check.perfBudget as unknown as Parameters<typeof sql.json>[0])},
             ${check.diffThreshold}, ${check.severityLoad}, ${check.severityConsole},
             ${check.severitySelector}, ${check.severityPerf}, ${check.baselineImageRef},
             ${check.createdAt}, ${check.updatedAt})
          returning *`;
        return toUICheck(rows[0]!);
      },

      async update(id, patch) {
        const sql = getSql();
        const row = uicheckPatchRow(sql, patch);
        const rows = Object.keys(row).length
          ? await sql<UICheckRow[]>`
              update ui_checks set ${sql(row)}, updated_at = now() where id = ${id} returning *`
          : await sql<UICheckRow[]>`
              update ui_checks set updated_at = now() where id = ${id} returning *`;
        return rows[0] ? toUICheck(rows[0]) : null;
      },

      async remove(id) {
        const sql = getSql();
        const rows = await sql<UICheckRow[]>`delete from ui_checks where id = ${id} returning *`;
        return rows[0] ? toUICheck(rows[0]) : null;
      },
    },

    checkRuns: {
      async insert(run) {
        const sql = getSql();
        const rows = await sql<CheckRunRow[]>`
          insert into check_runs
            (id, check_id, check_type, started_at, finished_at, status, latency_ms, error,
             artifacts_ref, critical_failed)
          values
            (${run.id}, ${run.checkId}, ${run.checkType}, ${run.startedAt}, ${run.finishedAt},
             ${run.status}, ${run.latencyMs}, ${run.error}, ${run.artifactsRef}, ${run.criticalFailed})
          returning *`;
        return toCheckRun(rows[0]!);
      },

      async listByCheck(checkId, limit = 50) {
        const sql = getSql();
        const rows = await sql<CheckRunRow[]>`
          select * from check_runs where check_id = ${checkId}
          order by started_at desc limit ${limit}`;
        return rows.map(toCheckRun);
      },

      async listByCheckInWindow(checkId, from, to) {
        const sql = getSql();
        const rows = await sql<CheckRunRow[]>`
          select * from check_runs
          where check_id = ${checkId} and started_at >= ${from} and started_at < ${to}
          order by started_at`;
        return rows.map(toCheckRun);
      },

      async setArtifactsRef(runId, artifactsRef) {
        const sql = getSql();
        const rows = await sql<CheckRunRow[]>`
          update check_runs set artifacts_ref = ${artifactsRef} where id = ${runId} returning *`;
        return rows[0] ? toCheckRun(rows[0]) : null;
      },

      async latestFinishedAt() {
        const sql = getSql();
        const rows = await sql<{ max: Date | null }[]>`
          select max(finished_at) as max from check_runs`;
        return rows[0]?.max ?? null;
      },
    },

    incidents: {
      async getOpenByCheck(checkId) {
        const sql = getSql();
        const rows = await sql<IncidentRow[]>`
          select * from incidents
          where check_id = ${checkId} and closed_at is null
          order by opened_at desc limit 1`;
        return rows[0] ? toIncident(rows[0]) : null;
      },

      async insert(incident) {
        const sql = getSql();
        const rows = await sql<IncidentRow[]>`
          insert into incidents (id, check_id, opened_at, closed_at, run_ids)
          values (${incident.id}, ${incident.checkId}, ${incident.openedAt},
                  ${incident.closedAt}, ${incident.runIds})
          returning *`;
        return toIncident(rows[0]!);
      },

      async update(id, patch) {
        const sql = getSql();
        const row = incidentPatchRow(patch);
        const rows = Object.keys(row).length
          ? await sql<IncidentRow[]>`update incidents set ${sql(row)} where id = ${id} returning *`
          : await sql<IncidentRow[]>`select * from incidents where id = ${id} limit 1`;
        return rows[0] ? toIncident(rows[0]) : null;
      },

      // Join incident → check → site → project. `check_id` is polymorphic (no FK):
      // an incident originates from a heartbeat check *or* a UI check (#14), so
      // resolve the owning site from whichever table holds the id.
      async listByProject(projectId) {
        const sql = getSql();
        const rows = await sql<IncidentRow[]>`
          select i.* from incidents i
          join sites s on s.id = coalesce(
            (select hc.site_id from heartbeat_checks hc where hc.id = i.check_id),
            (select uc.site_id from ui_checks uc where uc.id = i.check_id)
          )
          where s.project_id = ${projectId}
          order by i.opened_at desc`;
        return rows.map(toIncident);
      },
    },

    verdicts: {
      async insert(verdict) {
        const sql = getSql();
        const rows = await sql<AgentVerdictRow[]>`
          insert into agent_verdicts (id, run_id, verdict, confidence, reasoning, model, created_at)
          values (${verdict.id}, ${verdict.runId}, ${verdict.verdict}, ${verdict.confidence},
                  ${verdict.reasoning}, ${verdict.model}, ${verdict.createdAt})
          returning *`;
        return toAgentVerdict(rows[0]!);
      },

      async listByRun(runId) {
        const sql = getSql();
        const rows = await sql<AgentVerdictRow[]>`
          select * from agent_verdicts where run_id = ${runId} order by created_at desc`;
        return rows.map(toAgentVerdict);
      },

      async latestByRun(runId) {
        const sql = getSql();
        const rows = await sql<AgentVerdictRow[]>`
          select * from agent_verdicts where run_id = ${runId}
          order by created_at desc limit 1`;
        return rows[0] ? toAgentVerdict(rows[0]) : null;
      },
    },

    audit: {
      async append(entry) {
        const sql = getSql();
        const rows = await sql<AuditRow[]>`
          insert into audit_log (id, user_id, entity_type, entity_id, action, diff_json, created_at)
          values (${entry.id}, ${entry.userId}, ${entry.entityType}, ${entry.entityId},
                  ${entry.action}, ${sql.json(entry.diff as Parameters<typeof sql.json>[0])}, ${entry.createdAt})
          returning *`;
        return toAudit(rows[0]!);
      },

      async list() {
        const sql = getSql();
        const rows = await sql<AuditRow[]>`select * from audit_log order by created_at desc`;
        return rows.map(toAudit);
      },
    },

    users: {
      // Read-only: the `users` table is owned by auth (#03); config-repo only
      // resolves a Project's manager for digest delivery (#15). Soft-deleted users
      // are excluded so a removed manager never receives a digest.
      async get(id) {
        const sql = getSql();
        const rows = await sql<UserRow[]>`
          select id, email, role from users
          where id = ${id} and deleted_at is null limit 1`;
        return rows[0] ? toUser(rows[0]) : null;
      },
    },
  };
}

/** Maps a `ProjectPatch` to snake_case columns for a dynamic `update ... set` write. */
function projectPatchRow(patch: ProjectPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.contacts !== undefined) row.contacts = patch.contacts;
  if (patch.slackChannel !== undefined) row.slack_channel = patch.slackChannel;
  if (patch.slackWebhookUrl !== undefined) row.slack_webhook_url = patch.slackWebhookUrl;
  if (patch.alertEmails !== undefined) row.alert_emails = patch.alertEmails;
  if (patch.retentionDays !== undefined) row.retention_days = patch.retentionDays;
  if (patch.assignedManagerId !== undefined) row.assigned_manager_id = patch.assignedManagerId;
  if (patch.digestEmailEnabled !== undefined) row.digest_email_enabled = patch.digestEmailEnabled;
  if (patch.digestSlackEnabled !== undefined) row.digest_slack_enabled = patch.digestSlackEnabled;
  return row;
}

/** Maps a `HeartbeatCheckPatch` to snake_case columns for a dynamic `update ... set` write. */
function checkPatchRow(sql: Sql, patch: HeartbeatCheckPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.groupId !== undefined) row.group_id = patch.groupId;
  if (patch.path !== undefined) row.path = patch.path;
  if (patch.bodyAssertion !== undefined) {
    row.body_assertion = patch.bodyAssertion
      ? sql.json(patch.bodyAssertion as unknown as Parameters<typeof sql.json>[0])
      : null;
  }
  if (patch.certCheck !== undefined) row.cert_check = patch.certCheck;
  if (patch.dnsCheck !== undefined) row.dns_check = patch.dnsCheck;
  if (patch.intervalSeconds !== undefined) row.interval_seconds = patch.intervalSeconds;
  if (patch.alertAfterNFails !== undefined) row.alert_after_n_fails = patch.alertAfterNFails;
  return row;
}

/** Maps a `UICheckPatch` to snake_case columns for a dynamic `update ... set` write. */
function uicheckPatchRow(sql: Sql, patch: UICheckPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.groupId !== undefined) row.group_id = patch.groupId;
  if (patch.intervalSeconds !== undefined) row.interval_seconds = patch.intervalSeconds;
  if (patch.path !== undefined) row.path = patch.path;
  if (patch.viewports !== undefined) row.viewports = patch.viewports;
  if (patch.selectors !== undefined) row.selectors = patch.selectors;
  if (patch.ignoreRegions !== undefined) row.ignore_regions = patch.ignoreRegions;
  if (patch.perfBudget !== undefined && patch.perfBudget !== null) {
    row.perf_budget = sql.json(patch.perfBudget as unknown as Parameters<typeof sql.json>[0]);
  }
  if (patch.diffThreshold !== undefined) row.diff_threshold = patch.diffThreshold;
  if (patch.severityLoad !== undefined) row.severity_load = patch.severityLoad;
  if (patch.severityConsole !== undefined) row.severity_console = patch.severityConsole;
  if (patch.severitySelector !== undefined) row.severity_selector = patch.severitySelector;
  if (patch.severityPerf !== undefined) row.severity_perf = patch.severityPerf;
  if (patch.baselineImageRef !== undefined) row.baseline_image_ref = patch.baselineImageRef;
  return row;
}

/** Maps a `CheckGroupPatch` to snake_case columns for a dynamic `update ... set` write. */
function groupPatchRow(sql: Sql, patch: CheckGroupPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.defaultIntervalSeconds !== undefined) {
    row.default_interval_seconds = patch.defaultIntervalSeconds;
  }
  if (patch.defaultAlertAfterNFails !== undefined) {
    row.default_alert_after_n_fails = patch.defaultAlertAfterNFails;
  }
  if (patch.defaultAlertRouting !== undefined) {
    row.default_alert_routing = patch.defaultAlertRouting
      ? sql.json(patch.defaultAlertRouting as unknown as Parameters<typeof sql.json>[0])
      : null;
  }
  return row;
}

/** Maps an incident patch to snake_case columns for a dynamic `update ... set` write. */
function incidentPatchRow(patch: { closedAt?: Date; runIds?: string[] }): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.closedAt !== undefined) row.closed_at = patch.closedAt;
  if (patch.runIds !== undefined) row.run_ids = patch.runIds;
  return row;
}
