import { expect, test } from "bun:test";
import { buildDigest } from "./builder.ts";
import type { BuildDigestInput, DigestIncident, DigestRun } from "./types.ts";

// A fixed day: the window is [day 0, day +1). `h(n)` is n hours into the day.
const DAY = new Date("2026-06-02T00:00:00.000Z");
const NEXT = new Date("2026-06-03T00:00:00.000Z");
const h = (hours: number): Date => new Date(DAY.getTime() + hours * 3_600_000);

const run = (over: Partial<DigestRun> = {}): DigestRun => ({
  checkId: "c1",
  checkLabel: "acme.test/health",
  checkType: "heartbeat",
  status: "pass",
  criticalFailed: null,
  startedAt: h(1),
  ...over,
});

const base = (over: Partial<BuildDigestInput> = {}): BuildDigestInput => ({
  projectId: "project-1",
  projectName: "Acme",
  range: { from: DAY, to: NEXT },
  runs: [],
  incidents: [],
  dashboardUrl: "http://localhost:3000/#/projects/project-1",
  ...over,
});

// ---- empty day ----

test("empty day: zero totals and empty sections", () => {
  const d = buildDigest(base());
  expect(d.totals).toEqual({ runs: 0, passed: 0, failed: 0 });
  expect(d.checks).toEqual([]);
  expect(d.regressedUIChecks).toEqual([]);
  expect(d.incidents).toEqual({ opened: [], closed: [] });
  expect(d.projectName).toBe("Acme");
  expect(d.dashboardUrl).toBe("http://localhost:3000/#/projects/project-1");
});

// ---- mixed pass/fail ----

test("mixed pass/fail: per-check counts and window totals", () => {
  const d = buildDigest(
    base({
      runs: [
        run({ checkId: "c1", checkLabel: "acme.test/health", status: "pass", startedAt: h(1) }),
        run({ checkId: "c1", checkLabel: "acme.test/health", status: "fail", startedAt: h(2) }),
        run({ checkId: "c1", checkLabel: "acme.test/health", status: "pass", startedAt: h(3) }),
        run({ checkId: "c2", checkLabel: "acme.test/checkout", status: "fail", startedAt: h(4) }),
      ],
    }),
  );
  expect(d.totals).toEqual({ runs: 4, passed: 2, failed: 2 });
  expect(d.checks).toEqual([
    { checkId: "c1", checkLabel: "acme.test/health", checkType: "heartbeat", passed: 2, failed: 1 },
    { checkId: "c2", checkLabel: "acme.test/checkout", checkType: "heartbeat", passed: 0, failed: 1 },
  ]);
});

test("runs outside the window are excluded", () => {
  const d = buildDigest(
    base({
      runs: [
        run({ startedAt: new Date(DAY.getTime() - 1) }), // just before from
        run({ startedAt: NEXT }), // == to (exclusive)
        run({ startedAt: h(12) }), // inside
      ],
    }),
  );
  expect(d.totals.runs).toBe(1);
});

// ---- regressed UI checks ----

test("a failing UI-check run surfaces as a regressed UI check; passing heartbeats do not", () => {
  const d = buildDigest(
    base({
      runs: [
        run({ checkId: "ui1", checkLabel: "acme.test/home", checkType: "uicheck", status: "fail", criticalFailed: false, startedAt: h(5) }),
        run({ checkId: "ui1", checkLabel: "acme.test/home", checkType: "uicheck", status: "fail", criticalFailed: false, startedAt: h(6) }),
        run({ checkId: "hb1", checkLabel: "acme.test/health", checkType: "heartbeat", status: "pass", startedAt: h(7) }),
      ],
    }),
  );
  expect(d.regressedUIChecks).toEqual([
    { checkId: "ui1", checkLabel: "acme.test/home", failed: 2 },
  ]);
});

test("a UI check with only passing runs is not regressed", () => {
  const d = buildDigest(
    base({
      runs: [run({ checkId: "ui1", checkLabel: "acme.test/home", checkType: "uicheck", status: "pass", startedAt: h(5) })],
    }),
  );
  expect(d.regressedUIChecks).toEqual([]);
});

// ---- incidents ----

const incident = (over: Partial<DigestIncident> = {}): DigestIncident => ({
  checkId: "c1",
  checkLabel: "acme.test/health",
  openedAt: h(2),
  closedAt: null,
  ...over,
});

test("open incident at end of day: listed under opened, still open, no closed", () => {
  const d = buildDigest(
    base({ incidents: [incident({ openedAt: h(23), closedAt: null })] }),
  );
  expect(d.incidents.opened).toEqual([
    { checkId: "c1", checkLabel: "acme.test/health", openedAt: h(23), closedAt: null, durationMs: null },
  ]);
  expect(d.incidents.closed).toEqual([]);
});

test("closed incident inside the day: listed under closed with downtime, and under opened (opened same day)", () => {
  const d = buildDigest(
    base({ incidents: [incident({ openedAt: h(8), closedAt: h(10) })] }),
  );
  expect(d.incidents.closed).toEqual([
    { checkId: "c1", checkLabel: "acme.test/health", openedAt: h(8), closedAt: h(10), durationMs: 2 * 3_600_000 },
  ]);
  expect(d.incidents.opened).toHaveLength(1);
});

test("incident opened before the window but closed inside: closed only, not opened", () => {
  const d = buildDigest(
    base({ incidents: [incident({ openedAt: new Date(DAY.getTime() - 3_600_000), closedAt: h(1) })] }),
  );
  expect(d.incidents.opened).toEqual([]);
  expect(d.incidents.closed).toHaveLength(1);
  expect(d.incidents.closed[0]!.durationMs).toBe(2 * 3_600_000);
});

test("incident fully outside the window appears in neither list", () => {
  const before = new Date(DAY.getTime() - 7_200_000);
  const d = buildDigest(
    base({ incidents: [incident({ openedAt: before, closedAt: new Date(DAY.getTime() - 3_600_000) })] }),
  );
  expect(d.incidents.opened).toEqual([]);
  expect(d.incidents.closed).toEqual([]);
});
