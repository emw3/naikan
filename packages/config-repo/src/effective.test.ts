import { expect, test } from "bun:test";
import { resolveEffectiveCheck, resolveEffectiveUICheck } from "./effective.ts";
import type { CheckGroup, HeartbeatCheck, UICheck } from "./types.ts";

function check(over: Partial<HeartbeatCheck> = {}): HeartbeatCheck {
  return {
    id: "c1",
    siteId: "s1",
    groupId: null,
    path: "/health",
    bodyAssertion: null,
    certCheck: false,
    dnsCheck: false,
    intervalSeconds: null,
    alertAfterNFails: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

function group(over: Partial<CheckGroup> = {}): CheckGroup {
  return {
    id: "g1",
    projectId: "cl1",
    name: "prod-critical",
    defaultIntervalSeconds: null,
    defaultAlertRouting: null,
    defaultAlertAfterNFails: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

test("no group: nulls fall through to system defaults", () => {
  const e = resolveEffectiveCheck(check(), null);
  expect(e.intervalSeconds).toBe(300);
  expect(e.alertAfterNFails).toBe(1);
  expect(e.alertRouting).toBeNull();
});

test("group with all defaults: check inherits every group default", () => {
  const g = group({
    defaultIntervalSeconds: 600,
    defaultAlertAfterNFails: 3,
    defaultAlertRouting: { slackChannel: "#prod", alertEmails: ["a@x.test"] },
  });
  const e = resolveEffectiveCheck(check({ groupId: g.id }), g);
  expect(e.intervalSeconds).toBe(600);
  expect(e.alertAfterNFails).toBe(3);
  expect(e.alertRouting).toEqual({ slackChannel: "#prod", alertEmails: ["a@x.test"] });
});

test("group with partial defaults: unset group fields fall through to system", () => {
  const g = group({ defaultIntervalSeconds: 600, defaultAlertAfterNFails: null });
  const e = resolveEffectiveCheck(check({ groupId: g.id }), g);
  expect(e.intervalSeconds).toBe(600); // from group
  expect(e.alertAfterNFails).toBe(1); // group null -> system
});

test("full check override: check values win over the group", () => {
  const g = group({ defaultIntervalSeconds: 600, defaultAlertAfterNFails: 3 });
  const e = resolveEffectiveCheck(
    check({ groupId: g.id, intervalSeconds: 60, alertAfterNFails: 5 }),
    g,
  );
  expect(e.intervalSeconds).toBe(60);
  expect(e.alertAfterNFails).toBe(5);
});

test("preserves the non-inherited check fields", () => {
  const e = resolveEffectiveCheck(check({ path: "/up", certCheck: true }), null);
  expect(e.path).toBe("/up");
  expect(e.certCheck).toBe(true);
  expect(e.id).toBe("c1");
});

// ---- UI checks (#14): only the interval inherits; default is daily ----

function uicheck(over: Partial<UICheck> = {}): UICheck {
  return {
    id: "u1",
    siteId: "s1",
    groupId: null,
    intervalSeconds: null,
    path: "/pricing",
    viewports: ["desktop"],
    selectors: [],
    ignoreRegions: [],
    perfBudget: { lcpMs: 2500, pageWeightBytes: 3_145_728, maxRequests: 100 },
    diffThreshold: 0.01,
    severityLoad: "critical",
    severityConsole: "warning",
    severitySelector: "warning",
    severityPerf: "warning",
    baselineImageRef: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

test("UI: no group → interval falls through to the daily system default", () => {
  const e = resolveEffectiveUICheck(uicheck(), null);
  expect(e.intervalSeconds).toBe(86_400);
});

test("UI: group default interval is inherited when the check leaves it null", () => {
  const g = group({ defaultIntervalSeconds: 3600 });
  const e = resolveEffectiveUICheck(uicheck({ groupId: g.id }), g);
  expect(e.intervalSeconds).toBe(3600);
});

test("UI: per-check interval override wins over group + system (AC #4)", () => {
  const g = group({ defaultIntervalSeconds: 3600 });
  const e = resolveEffectiveUICheck(uicheck({ groupId: g.id, intervalSeconds: 43_200 }), g);
  expect(e.intervalSeconds).toBe(43_200);
});

test("UI: preserves the non-inherited check fields", () => {
  const e = resolveEffectiveUICheck(uicheck({ path: "/checkout", severityConsole: "critical" }), null);
  expect(e.path).toBe("/checkout");
  expect(e.severityConsole).toBe("critical");
  expect(e.id).toBe("u1");
});
