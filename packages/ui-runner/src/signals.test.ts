import { expect, test } from "bun:test";
import { judgeSignals } from "./signals.ts";
import type { PerfBudget, Severity, SignalInput, SignalJudgeConfig, SignalKind } from "./types.ts";

const BUDGET: PerfBudget = { lcpMs: 2500, pageWeightBytes: 3 * 1024 * 1024, maxRequests: 100 };
const SEVERITIES: Record<SignalKind, Severity> = {
  load: "critical",
  console: "warning",
  selector: "warning",
  perf: "warning",
};

/** A clean page: navigated 200, no console errors, well within budget, no selectors required. */
const CLEAN: SignalInput = {
  nav: { ok: true, status: 200 },
  console: [],
  perf: { lcpMs: 1200, weightBytes: 1000, requestCount: 5 },
  selectorsPresent: {},
};

function judge(obs: SignalInput, overrides: Partial<SignalJudgeConfig> = {}) {
  const config: SignalJudgeConfig = { selectors: [], perfBudget: BUDGET, severities: SEVERITIES, ...overrides };
  const signals = judgeSignals(obs, config);
  return (kind: SignalKind) => signals.find((s) => s.kind === kind)!;
}

test("judges exactly the four signals in a stable order", () => {
  const signals = judgeSignals(CLEAN, { selectors: [], perfBudget: BUDGET, severities: SEVERITIES });
  expect(signals.map((s) => s.kind)).toEqual(["load", "console", "selector", "perf"]);
});

test("a clean page passes every signal", () => {
  const signals = judgeSignals(CLEAN, { selectors: [], perfBudget: BUDGET, severities: SEVERITIES });
  expect(signals.every((s) => s.pass)).toBe(true);
});

// ---- load ----

test("load passes on a 2xx response", () => {
  expect(judge(CLEAN)("load").pass).toBe(true);
});

test("load fails on a non-2xx response and reports the status", () => {
  const s = judge({ ...CLEAN, nav: { ok: true, status: 500 } })("load");
  expect(s.pass).toBe(false);
  expect(s.detail).toContain("500");
});

test("load fails on a transport error (no response)", () => {
  const s = judge({ ...CLEAN, nav: { ok: false, status: null } })("load");
  expect(s.pass).toBe(false);
  expect(s.detail.toLowerCase()).toContain("transport");
});

// ---- console ----

test("console fails when there is a console error and surfaces its text", () => {
  const s = judge({
    ...CLEAN,
    console: [
      { type: "log", text: "hello" },
      { type: "error", text: "ReferenceError: x is not defined" },
    ],
  })("console");
  expect(s.pass).toBe(false);
  expect(s.detail).toContain("ReferenceError: x is not defined");
});

test("console passes when only non-error messages are present", () => {
  const s = judge({
    ...CLEAN,
    console: [
      { type: "log", text: "hello" },
      { type: "warning", text: "deprecated" },
    ],
  })("console");
  expect(s.pass).toBe(true);
});

// ---- selector ----

test("selector passes vacuously when no selectors are required", () => {
  expect(judge(CLEAN, { selectors: [] })("selector").pass).toBe(true);
});

test("selector passes when every required selector resolved", () => {
  const s = judge({ ...CLEAN, selectorsPresent: { "#hero": true, ".cta": true } }, { selectors: ["#hero", ".cta"] })(
    "selector",
  );
  expect(s.pass).toBe(true);
});

test("selector fails and lists the missing selectors", () => {
  const s = judge({ ...CLEAN, selectorsPresent: { "#hero": true, ".cta": false } }, { selectors: ["#hero", ".cta"] })(
    "selector",
  );
  expect(s.pass).toBe(false);
  expect(s.detail).toContain(".cta");
  expect(s.detail).not.toContain("#hero");
});

// ---- perf ----

test("perf fails when LCP exceeds the budget", () => {
  const s = judge({ ...CLEAN, perf: { lcpMs: 4000, weightBytes: 1000, requestCount: 5 } })("perf");
  expect(s.pass).toBe(false);
  expect(s.detail).toContain("LCP");
});

test("perf fails when page weight exceeds the budget", () => {
  const s = judge({ ...CLEAN, perf: { lcpMs: 1000, weightBytes: 5 * 1024 * 1024, requestCount: 5 } })("perf");
  expect(s.pass).toBe(false);
});

test("perf fails when request count exceeds the budget", () => {
  const s = judge({ ...CLEAN, perf: { lcpMs: 1000, weightBytes: 1000, requestCount: 250 } })("perf");
  expect(s.pass).toBe(false);
});

test("perf passes when LCP is not reported (null)", () => {
  const s = judge({ ...CLEAN, perf: { lcpMs: null, weightBytes: 1000, requestCount: 5 } })("perf");
  expect(s.pass).toBe(true);
});

// ---- severity ----

test("each signal carries the configured severity for its kind", () => {
  const signals = judgeSignals(CLEAN, {
    selectors: [],
    perfBudget: BUDGET,
    severities: { load: "critical", console: "critical", selector: "warning", perf: "warning" },
  });
  expect(signals.find((s) => s.kind === "load")!.severity).toBe("critical");
  expect(signals.find((s) => s.kind === "console")!.severity).toBe("critical");
  expect(signals.find((s) => s.kind === "selector")!.severity).toBe("warning");
  expect(signals.find((s) => s.kind === "perf")!.severity).toBe("warning");
});
