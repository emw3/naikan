import { expect, test } from "bun:test";
import { canSeeProject, scopeProjects, type ManagedProject, type Scopable } from "./scope.ts";

const admin: Scopable = { id: "u-admin", role: "admin" };
const mara: Scopable = { id: "u-mara", role: "viewer" };
const noah: Scopable = { id: "u-noah", role: "viewer" };

const projects: ManagedProject[] = [
  { id: "c1", assignedManagerId: "u-mara" },
  { id: "c2", assignedManagerId: "u-mara" },
  { id: "c3", assignedManagerId: "u-someone-else" },
  { id: "c4", assignedManagerId: null },
];

test("admin sees every project", () => {
  expect(scopeProjects(admin, projects).map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4"]);
});

test("a manager sees only the projects assigned to them", () => {
  expect(scopeProjects(mara, projects).map((c) => c.id)).toEqual(["c1", "c2"]);
});

test("a viewer with no assignments sees every project", () => {
  expect(scopeProjects(noah, projects).map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4"]);
});

test("canSeeProject: manager allowed for assigned, denied for unassigned", () => {
  expect(canSeeProject(mara, "c1", projects)).toBe(true);
  expect(canSeeProject(mara, "c3", projects)).toBe(false);
  expect(canSeeProject(mara, "c4", projects)).toBe(false);
});

test("canSeeProject: admin and plain viewer allowed for any project", () => {
  expect(canSeeProject(admin, "c3", projects)).toBe(true);
  expect(canSeeProject(noah, "c3", projects)).toBe(true);
});

test("empty project set: nobody is a manager, so non-admins fall back to 'see all' (vacuously)", () => {
  expect(scopeProjects(mara, [])).toEqual([]);
});
