import { expect, test } from "bun:test";
import type { DigestPayload } from "@naikan/digest-builder";
import { renderDigestEmail, renderDigestSlack } from "./digest-templates.ts";

const range = { from: new Date("2026-06-02T00:00:00Z"), to: new Date("2026-06-03T00:00:00Z") };

const acme: DigestPayload = {
  projectId: "c-acme",
  projectName: "Acme",
  range,
  totals: { runs: 10, passed: 8, failed: 2 },
  checks: [
    { checkId: "hb1", checkLabel: "acme.test/health", checkType: "heartbeat", passed: 7, failed: 1 },
    { checkId: "ui1", checkLabel: "acme.test/home", checkType: "uicheck", passed: 1, failed: 1 },
  ],
  regressedUIChecks: [{ checkId: "ui1", checkLabel: "acme.test/home", failed: 1 }],
  incidents: {
    opened: [
      { checkId: "hb1", checkLabel: "acme.test/health", openedAt: new Date("2026-06-02T03:00:00Z"), closedAt: null, durationMs: null },
    ],
    closed: [],
  },
  dashboardUrl: "http://localhost:3000/#/projects/c-acme",
};

const beta: DigestPayload = {
  projectId: "c-beta",
  projectName: "Beta",
  range,
  totals: { runs: 5, passed: 5, failed: 0 },
  checks: [{ checkId: "hb2", checkLabel: "beta.test/health", checkType: "heartbeat", passed: 5, failed: 0 }],
  regressedUIChecks: [],
  incidents: {
    opened: [],
    closed: [
      { checkId: "hb2", checkLabel: "beta.test/health", openedAt: new Date("2026-06-01T22:00:00Z"), closedAt: new Date("2026-06-02T01:00:00Z"), durationMs: 3 * 3_600_000 },
    ],
  },
  dashboardUrl: "http://localhost:3000/#/projects/c-beta",
};

const quiet: DigestPayload = {
  projectId: "c-quiet",
  projectName: "Quiet Co",
  range,
  totals: { runs: 0, passed: 0, failed: 0 },
  checks: [],
  regressedUIChecks: [],
  incidents: { opened: [], closed: [] },
  dashboardUrl: "http://localhost:3000/#/projects/c-quiet",
};

// ---- Slack (per project) ----

test("renderDigestSlack carries project name, pass/fail tally, and the dashboard link", () => {
  const text = renderDigestSlack(acme);
  expect(text).toContain("Acme");
  expect(text).toContain("8"); // passed
  expect(text).toContain("2"); // failed
  expect(text).toContain("http://localhost:3000/#/projects/c-acme");
});

test("renderDigestSlack lists regressed UI checks when present", () => {
  expect(renderDigestSlack(acme)).toContain("acme.test/home");
});

test("renderDigestSlack omits the regression line when there are none", () => {
  expect(renderDigestSlack(beta).toLowerCase()).not.toContain("regress");
});

test("renderDigestSlack reads as quiet for a no-activity project", () => {
  const text = renderDigestSlack(quiet);
  expect(text).toContain("Quiet Co");
  expect(text).toContain("http://localhost:3000/#/projects/c-quiet");
});

// ---- Email (aggregated per manager) ----

test("renderDigestEmail aggregates all of a manager's projects in one message", () => {
  const msg = renderDigestEmail("Mara", [acme, beta]);
  expect(msg.subject.toLowerCase()).toContain("digest");
  expect(msg.text).toContain("Mara");
  expect(msg.text).toContain("Acme");
  expect(msg.text).toContain("Beta");
  // both deep-links present
  expect(msg.text).toContain("http://localhost:3000/#/projects/c-acme");
  expect(msg.text).toContain("http://localhost:3000/#/projects/c-beta");
  // a regression and an incident surface somewhere
  expect(msg.text).toContain("acme.test/home");
  expect(msg.text).toContain("acme.test/health");
});

test("renderDigestEmail subject reflects how many projects it covers", () => {
  expect(renderDigestEmail("Mara", [acme, beta]).subject).toContain("2");
});

test("renderDigestEmail closed-incident line shows downtime duration", () => {
  expect(renderDigestEmail("Mara", [beta]).text).toContain("3h");
});

test("renderDigestEmail still renders a section for a no-activity project", () => {
  expect(renderDigestEmail("Mara", [quiet]).text).toContain("Quiet Co");
});
