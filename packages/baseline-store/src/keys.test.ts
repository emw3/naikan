import { expect, test } from "bun:test";
import { artifactKeys, TOMBSTONE_REF } from "./keys.ts";

test("run screenshot key follows projects/<id>/checks/<id>/runs/<run_id>/<viewport>.png", () => {
  expect(artifactKeys.runScreenshot("c1", "chk7", "run42", "desktop")).toBe(
    "projects/c1/checks/chk7/runs/run42/desktop.png",
  );
});

test("run diff key is distinguishable from the screenshot at the same viewport", () => {
  expect(artifactKeys.runDiff("c1", "chk7", "run42", "mobile")).toBe(
    "projects/c1/checks/chk7/runs/run42/mobile.diff.png",
  );
});

test("baseline key lives outside the runs/ subtree so the retention reaper can exempt it", () => {
  const baseline = artifactKeys.baseline("c1", "chk7", "tablet");
  expect(baseline).toBe("projects/c1/checks/chk7/baseline/tablet.png");
  expect(baseline).not.toContain("/runs/");
});

test("run manifest key lives in the run subtree so it is reaped with the run", () => {
  const manifest = artifactKeys.runManifest("c1", "chk7", "run42");
  expect(manifest).toBe("projects/c1/checks/chk7/runs/run42/manifest.json");
  expect(manifest.startsWith(artifactKeys.runsPrefix("c1", "chk7"))).toBe(true);
});

test("baseline manifest key lives in the baseline subtree so the reaper exempts it", () => {
  const manifest = artifactKeys.baselineManifest("c1", "chk7");
  expect(manifest).toBe("projects/c1/checks/chk7/baseline/manifest.json");
  expect(manifest.startsWith(artifactKeys.baselinePrefix("c1", "chk7"))).toBe(true);
  expect(manifest).not.toContain("/runs/");
});

test("runPrefix scopes a list() to a single run's subtree so the reaper deletes one run", () => {
  const prefix = artifactKeys.runPrefix("c1", "chk7", "run42");
  expect(prefix).toBe("projects/c1/checks/chk7/runs/run42/");
  // The run's screenshot + diff + manifest all sit under it…
  expect(artifactKeys.runScreenshot("c1", "chk7", "run42", "desktop").startsWith(prefix)).toBe(true);
  expect(artifactKeys.runManifest("c1", "chk7", "run42").startsWith(prefix)).toBe(true);
  // …but a sibling run does NOT, so listing this prefix never reaps another run.
  expect(artifactKeys.runScreenshot("c1", "chk7", "run99", "desktop").startsWith(prefix)).toBe(false);
});

test("TOMBSTONE_REF is a distinct sentinel that can never collide with a real artifact key", () => {
  // Written to CheckRun.artifactsRef once a run's artifacts are reaped (#17).
  // Must be distinguishable from a live manifest key and from null.
  expect(TOMBSTONE_REF).not.toContain("projects/");
  expect(TOMBSTONE_REF.startsWith(artifactKeys.runsPrefix("c1", "chk7"))).toBe(false);
  expect(TOMBSTONE_REF.length).toBeGreaterThan(0);
});

test("runsPrefix scopes a list() to one check's run artifacts only", () => {
  expect(artifactKeys.runsPrefix("c1", "chk7")).toBe(
    "projects/c1/checks/chk7/runs/",
  );
});

test("projectPrefix scopes a list() to everything owned by one project", () => {
  expect(artifactKeys.projectPrefix("c1")).toBe("projects/c1/");
});

test("rejects id segments containing a slash (would corrupt the key hierarchy)", () => {
  expect(() => artifactKeys.runScreenshot("c1/evil", "chk7", "run42", "desktop")).toThrow();
});

test("rejects empty id segments", () => {
  expect(() => artifactKeys.baseline("c1", "", "desktop")).toThrow();
});
