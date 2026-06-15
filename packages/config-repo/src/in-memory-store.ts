/**
 * In-memory `ConfigStore`, used by the repo unit tests and by the no-DB dev server
 * (matching the DB-free path from issue #01). Dumb CRUD only — validation and audit
 * live in the repo. Production uses the Postgres-backed store instead.
 */
import type {
  AgentVerdict,
  AuditLogEntry,
  CheckGroup,
  CheckGroupPatch,
  CheckRun,
  Project,
  ProjectPatch,
  ConfigStore,
  HeartbeatCheck,
  HeartbeatCheckPatch,
  Incident,
  Site,
  SitePatch,
  UICheck,
  UICheckPatch,
  User,
} from "./types.ts";

/** A user as held in the in-memory store — carries `deletedAt` so `users.get` can hide soft-deletes. */
interface StoredUser extends User {
  deletedAt: Date | null;
}

export class InMemoryConfigStore implements ConfigStore {
  private readonly projectsById = new Map<string, Project>();
  private readonly sitesById = new Map<string, Site>();
  private readonly checksById = new Map<string, HeartbeatCheck>();
  private readonly uichecksById = new Map<string, UICheck>();
  private readonly groupsById = new Map<string, CheckGroup>();
  private readonly runs: CheckRun[] = [];
  private readonly incidentRows: Incident[] = [];
  private readonly verdictRows: AgentVerdict[] = [];
  private readonly auditRows: AuditLogEntry[] = [];
  private readonly usersById = new Map<string, StoredUser>();
  private readonly now: () => Date;

  // Explicit assignment, not a constructor parameter property — see ValidationError
  // in repo.ts: parameter properties break Node's strip-only TS loader (ADR-0005).
  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  /** Drops a site and (matching the FK CASCADE) every check under it. */
  private cascadeSite(siteId: string): void {
    this.sitesById.delete(siteId);
    for (const [cid, c] of this.checksById) {
      if (c.siteId === siteId) this.checksById.delete(cid);
    }
    for (const [uid, u] of this.uichecksById) {
      if (u.siteId === siteId) this.uichecksById.delete(uid);
    }
  }

  readonly projects = {
    list: (): Promise<Project[]> =>
      Promise.resolve(
        [...this.projectsById.values()]
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map(clone),
      ),

    get: (id: string): Promise<Project | null> => {
      const c = this.projectsById.get(id);
      return Promise.resolve(c ? clone(c) : null);
    },

    insert: (project: Project): Promise<Project> => {
      this.projectsById.set(project.id, clone(project));
      return Promise.resolve(clone(project));
    },

    update: (id: string, patch: ProjectPatch): Promise<Project | null> => {
      const c = this.projectsById.get(id);
      if (!c) return Promise.resolve(null);
      const next: Project = { ...c, ...patch, updatedAt: this.now() };
      this.projectsById.set(id, next);
      return Promise.resolve(clone(next));
    },

    remove: (id: string): Promise<Project | null> => {
      const c = this.projectsById.get(id);
      if (!c) return Promise.resolve(null);
      this.projectsById.delete(id);
      // Cascade sites — and each site's checks (mirrors the FK ON DELETE CASCADE).
      for (const [sid, s] of this.sitesById) {
        if (s.projectId === id) this.cascadeSite(sid);
      }
      // Cascade the project's check groups (FK ON DELETE CASCADE).
      for (const [gid, g] of this.groupsById) {
        if (g.projectId === id) this.groupsById.delete(gid);
      }
      return Promise.resolve(clone(c));
    },
  };

  readonly sites = {
    listByProject: (projectId: string): Promise<Site[]> =>
      Promise.resolve(
        [...this.sitesById.values()]
          .filter((s) => s.projectId === projectId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map(clone),
      ),

    get: (id: string): Promise<Site | null> => {
      const s = this.sitesById.get(id);
      return Promise.resolve(s ? clone(s) : null);
    },

    insert: (site: Site): Promise<Site> => {
      this.sitesById.set(site.id, clone(site));
      return Promise.resolve(clone(site));
    },

    update: (id: string, patch: SitePatch): Promise<Site | null> => {
      const s = this.sitesById.get(id);
      if (!s) return Promise.resolve(null);
      const next: Site = { ...s, ...patch, updatedAt: this.now() };
      this.sitesById.set(id, next);
      return Promise.resolve(clone(next));
    },

    remove: (id: string): Promise<Site | null> => {
      const s = this.sitesById.get(id);
      if (!s) return Promise.resolve(null);
      this.cascadeSite(id);
      return Promise.resolve(clone(s));
    },
  };

  readonly groups = {
    listByProject: (projectId: string): Promise<CheckGroup[]> =>
      Promise.resolve(
        [...this.groupsById.values()]
          .filter((g) => g.projectId === projectId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map(cloneGroup),
      ),

    get: (id: string): Promise<CheckGroup | null> => {
      const g = this.groupsById.get(id);
      return Promise.resolve(g ? cloneGroup(g) : null);
    },

    insert: (group: CheckGroup): Promise<CheckGroup> => {
      this.groupsById.set(group.id, cloneGroup(group));
      return Promise.resolve(cloneGroup(group));
    },

    update: (id: string, patch: CheckGroupPatch): Promise<CheckGroup | null> => {
      const g = this.groupsById.get(id);
      if (!g) return Promise.resolve(null);
      const next: CheckGroup = { ...g, ...patch, updatedAt: this.now() };
      this.groupsById.set(id, next);
      return Promise.resolve(cloneGroup(next));
    },

    remove: (id: string): Promise<CheckGroup | null> => {
      const g = this.groupsById.get(id);
      if (!g) return Promise.resolve(null);
      this.groupsById.delete(id);
      // Member checks fall back to no group (mirrors the FK ON DELETE SET NULL).
      for (const [cid, c] of this.checksById) {
        if (c.groupId === id) this.checksById.set(cid, { ...c, groupId: null });
      }
      for (const [uid, u] of this.uichecksById) {
        if (u.groupId === id) this.uichecksById.set(uid, { ...u, groupId: null });
      }
      return Promise.resolve(cloneGroup(g));
    },
  };

  readonly checks = {
    listBySite: (siteId: string): Promise<HeartbeatCheck[]> =>
      Promise.resolve(
        [...this.checksById.values()]
          .filter((c) => c.siteId === siteId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map(cloneCheck),
      ),

    listAll: (): Promise<HeartbeatCheck[]> =>
      Promise.resolve(
        [...this.checksById.values()]
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map(cloneCheck),
      ),

    get: (id: string): Promise<HeartbeatCheck | null> => {
      const c = this.checksById.get(id);
      return Promise.resolve(c ? cloneCheck(c) : null);
    },

    insert: (check: HeartbeatCheck): Promise<HeartbeatCheck> => {
      this.checksById.set(check.id, cloneCheck(check));
      return Promise.resolve(cloneCheck(check));
    },

    update: (id: string, patch: HeartbeatCheckPatch): Promise<HeartbeatCheck | null> => {
      const c = this.checksById.get(id);
      if (!c) return Promise.resolve(null);
      const next: HeartbeatCheck = { ...c, ...patch, updatedAt: this.now() };
      this.checksById.set(id, next);
      return Promise.resolve(cloneCheck(next));
    },

    remove: (id: string): Promise<HeartbeatCheck | null> => {
      const c = this.checksById.get(id);
      if (!c) return Promise.resolve(null);
      this.checksById.delete(id);
      return Promise.resolve(cloneCheck(c));
    },
  };

  readonly uichecks = {
    listBySite: (siteId: string): Promise<UICheck[]> =>
      Promise.resolve(
        [...this.uichecksById.values()]
          .filter((c) => c.siteId === siteId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map(cloneUICheck),
      ),

    listAll: (): Promise<UICheck[]> =>
      Promise.resolve(
        [...this.uichecksById.values()]
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map(cloneUICheck),
      ),

    get: (id: string): Promise<UICheck | null> => {
      const c = this.uichecksById.get(id);
      return Promise.resolve(c ? cloneUICheck(c) : null);
    },

    insert: (check: UICheck): Promise<UICheck> => {
      this.uichecksById.set(check.id, cloneUICheck(check));
      return Promise.resolve(cloneUICheck(check));
    },

    update: (id: string, patch: UICheckPatch): Promise<UICheck | null> => {
      const c = this.uichecksById.get(id);
      if (!c) return Promise.resolve(null);
      const next: UICheck = { ...c, ...patch, updatedAt: this.now() } as UICheck;
      this.uichecksById.set(id, next);
      return Promise.resolve(cloneUICheck(next));
    },

    remove: (id: string): Promise<UICheck | null> => {
      const c = this.uichecksById.get(id);
      if (!c) return Promise.resolve(null);
      this.uichecksById.delete(id);
      return Promise.resolve(cloneUICheck(c));
    },
  };

  readonly checkRuns = {
    insert: (run: CheckRun): Promise<CheckRun> => {
      this.runs.push({ ...run });
      return Promise.resolve({ ...run });
    },

    listByCheck: (checkId: string, limit = 50): Promise<CheckRun[]> =>
      Promise.resolve(
        this.runs
          .filter((r) => r.checkId === checkId)
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
          .slice(0, limit)
          .map((r) => ({ ...r })),
      ),

    // Half-open `[from, to)`, oldest first, uncapped (mirrors the SQL range query).
    listByCheckInWindow: (checkId: string, from: Date, to: Date): Promise<CheckRun[]> =>
      Promise.resolve(
        this.runs
          .filter(
            (r) =>
              r.checkId === checkId &&
              r.startedAt.getTime() >= from.getTime() &&
              r.startedAt.getTime() < to.getTime(),
          )
          .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
          .map((r) => ({ ...r })),
      ),

    setArtifactsRef: (runId: string, artifactsRef: string | null): Promise<CheckRun | null> => {
      const row = this.runs.find((r) => r.id === runId);
      if (!row) return Promise.resolve(null);
      row.artifactsRef = artifactsRef;
      return Promise.resolve({ ...row });
    },

    latestFinishedAt: (): Promise<Date | null> => {
      let max: Date | null = null;
      for (const r of this.runs) {
        if (!max || r.finishedAt.getTime() > max.getTime()) max = r.finishedAt;
      }
      return Promise.resolve(max ? new Date(max.getTime()) : null);
    },
  };

  readonly incidents = {
    getOpenByCheck: (checkId: string): Promise<Incident | null> => {
      const open = this.incidentRows.find((i) => i.checkId === checkId && i.closedAt === null);
      return Promise.resolve(open ? cloneIncident(open) : null);
    },

    insert: (incident: Incident): Promise<Incident> => {
      this.incidentRows.push(cloneIncident(incident));
      return Promise.resolve(cloneIncident(incident));
    },

    update: (id: string, patch: { closedAt?: Date; runIds?: string[] }): Promise<Incident | null> => {
      const i = this.incidentRows.find((x) => x.id === id);
      if (!i) return Promise.resolve(null);
      if (patch.closedAt !== undefined) i.closedAt = patch.closedAt;
      if (patch.runIds !== undefined) i.runIds = [...patch.runIds];
      return Promise.resolve(cloneIncident(i));
    },

    // Resolve project ownership via the check → site → project chain (mirrors the
    // SQL join). The check is polymorphic — heartbeat *or* uicheck (#14) — so try
    // both tables. Incidents whose check was deleted are excluded (no FK; the
    // reaper prunes them in #17).
    listByProject: (projectId: string): Promise<Incident[]> =>
      Promise.resolve(
        this.incidentRows
          .filter((i) => {
            const siteId =
              this.checksById.get(i.checkId)?.siteId ?? this.uichecksById.get(i.checkId)?.siteId;
            if (siteId === undefined) return false;
            return this.sitesById.get(siteId)?.projectId === projectId;
          })
          .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())
          .map(cloneIncident),
      ),
  };

  readonly verdicts = {
    insert: (verdict: AgentVerdict): Promise<AgentVerdict> => {
      this.verdictRows.push({ ...verdict });
      return Promise.resolve({ ...verdict });
    },

    listByRun: (runId: string): Promise<AgentVerdict[]> =>
      Promise.resolve(
        this.verdictRows
          .filter((v) => v.runId === runId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((v) => ({ ...v })),
      ),

    latestByRun: (runId: string): Promise<AgentVerdict | null> => {
      // Last-write-wins on equal timestamps: scan in insertion order keeping the
      // newest, so the most recently recorded verdict surfaces (matches the SQL
      // store's `order by created_at desc limit 1` for distinct timestamps).
      let latest: AgentVerdict | null = null;
      for (const v of this.verdictRows) {
        if (v.runId === runId && (!latest || v.createdAt.getTime() >= latest.createdAt.getTime())) {
          latest = v;
        }
      }
      return Promise.resolve(latest ? { ...latest } : null);
    },
  };

  readonly audit = {
    append: (entry: AuditLogEntry): Promise<AuditLogEntry> => {
      this.auditRows.push({ ...entry });
      return Promise.resolve({ ...entry });
    },

    list: (): Promise<AuditLogEntry[]> =>
      // Newest first.
      Promise.resolve([...this.auditRows].reverse().map((e) => ({ ...e }))),
  };

  readonly users = {
    // Read-only manager lookup (#15); soft-deleted users resolve to null, matching
    // the SQL store's `deleted_at is null` filter and auth's own reads.
    get: (id: string): Promise<User | null> => {
      const u = this.usersById.get(id);
      if (!u || u.deletedAt !== null) return Promise.resolve(null);
      return Promise.resolve({ id: u.id, email: u.email, role: u.role });
    },
  };

  /**
   * Test/dev fixture: insert a user the store can resolve via `users.get`. The
   * repo never creates users (auth owns that), so the in-memory store seeds them
   * directly for digest tests + the no-DB dev server.
   */
  seedUser(user: StoredUser): void {
    this.usersById.set(user.id, { ...user });
  }
}

/** Shallow clone so callers can't mutate the stored row in place (arrays copied too). */
function clone<T extends Project | Site>(row: T): T {
  if ("alertEmails" in row) {
    return { ...row, alertEmails: [...(row as Project).alertEmails] } as T;
  }
  return { ...row };
}

/** Clone a check, copying the nested bodyAssertion so callers can't mutate it in place. */
function cloneCheck(c: HeartbeatCheck): HeartbeatCheck {
  return { ...c, bodyAssertion: c.bodyAssertion ? { ...c.bodyAssertion } : null };
}

/** Clone a UI check, deep-copying its arrays + perfBudget so callers can't mutate in place. */
function cloneUICheck(c: UICheck): UICheck {
  return {
    ...c,
    viewports: [...c.viewports],
    selectors: [...c.selectors],
    ignoreRegions: [...c.ignoreRegions],
    perfBudget: { ...c.perfBudget },
  };
}

/** Clone a group, deep-copying the nested routing so callers can't mutate it in place. */
function cloneGroup(g: CheckGroup): CheckGroup {
  return {
    ...g,
    defaultAlertRouting: g.defaultAlertRouting
      ? { ...g.defaultAlertRouting, alertEmails: [...g.defaultAlertRouting.alertEmails] }
      : null,
  };
}

/** Clone an incident, copying the runIds array so callers can't mutate it in place. */
function cloneIncident(i: Incident): Incident {
  return { ...i, runIds: [...i.runIds] };
}
