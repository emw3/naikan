/**
 * Manager scoping for every authenticated *read* surface (#16).
 *
 * Roles are flat — `admin` | `viewer` (types.ts). A "manager" is not a role: it
 * is a user who is the `assignedManagerId` of one or more Projects. PRODUCT.md:
 * "managers are scoped to their assigned projects on read surfaces." Reconciling
 * that with the issue's "Admin sees all, Viewer sees all, Manager sees only
 * assigned", the single rule that makes all three true is:
 *
 *   - admin                              → every project
 *   - assigned to ≥1 project (a manager)  → only the projects assigned to them
 *   - assigned to 0 projects (plain viewer) → every project
 *
 * Whether a user is "a manager" is therefore data-driven (determined by the
 * project set, not a role flag) — which is why the single-project checks need the
 * full project list, not just the target project.
 *
 * Scoping only ever *restricts* managers; admins and unassigned viewers see all.
 * Every project-scoped read route (projects, sites, checks, runs, groups,
 * incidents, and the dashboard views) gates through `projectGate` so the boundary
 * is enforced consistently — not just on the surfaces a scoped UI happens to link.
 */
import type { ConfigRepo } from "@naikan/config-repo";

/** The minimum a user needs to be scoped: who they are and their flat role. */
export interface Scopable {
  id: string;
  role: "admin" | "viewer";
}

/** The minimum a project needs to be scoped: its id and its assigned manager (if any). */
export interface ManagedProject {
  id: string;
  assignedManagerId: string | null;
}

/** Filter a project list to those visible to `user` (see the module doc for the rule). */
export function scopeProjects<T extends ManagedProject>(user: Scopable, projects: T[]): T[] {
  if (user.role === "admin") return projects;
  const assigned = projects.filter((c) => c.assignedManagerId === user.id);
  return assigned.length > 0 ? assigned : projects;
}

/** Whether `user` may see the single project `projectId`, given the full project list. */
export function canSeeProject(user: Scopable, projectId: string, projects: ManagedProject[]): boolean {
  return scopeProjects(user, projects).some((c) => c.id === projectId);
}

/** A synchronous predicate: is the project (by id) within the user's portfolio? */
export type ProjectGate = (projectId: string | null | undefined) => boolean;

/**
 * Build a visibility predicate for `user` from a single project-list snapshot.
 * Call once at the top of a request handler, then check resolved project ids
 * synchronously — so a route guarding many resources still issues one
 * `listProjects()`.
 */
export async function projectGate(
  repo: Pick<ConfigRepo, "listProjects">,
  user: Scopable,
): Promise<ProjectGate> {
  const projects = await repo.listProjects();
  return (projectId) => projectId != null && canSeeProject(user, projectId, projects);
}
