/**
 * Signal judgment (#13) — turns one viewport's raw `@naikan/capture`
 * observations into the four synthetic Signals. This is where the domain layer
 * makes the pass/fail calls Capture refuses to make (ADR-0006):
 *
 * - **load**     — transport succeeded *and* the HTTP status is 2xx.
 * - **console**  — no `error`-level console line (incl. uncaught exceptions).
 * - **selector** — every required selector resolved to ≥1 element (vacuously
 *                  true when none are required).
 * - **perf**     — LCP, page weight, and request count all within `perfBudget`
 *                  (an unreported LCP does not fail the budget).
 *
 * Pure and per-viewport: a run aggregates these across viewports (any failed
 * signal fails the run); routing by `severity` happens later (#14).
 */
import type { Signal, SignalInput, SignalJudgeConfig, SignalKind } from "./types.ts";

/** Judge the four signals for one viewport, in a stable order. */
export function judgeSignals(input: SignalInput, config: SignalJudgeConfig): Signal[] {
  return [
    signal("load", config, judgeLoad(input)),
    signal("console", config, judgeConsole(input)),
    signal("selector", config, judgeSelector(input, config)),
    signal("perf", config, judgePerf(input, config)),
  ];
}

/** Stamp a kind's verdict with the severity configured for it. */
function signal(kind: SignalKind, config: SignalJudgeConfig, v: { pass: boolean; detail: string }): Signal {
  return { kind, pass: v.pass, severity: config.severities[kind], detail: v.detail };
}

function judgeLoad({ nav }: SignalInput): { pass: boolean; detail: string } {
  if (!nav.ok) return { pass: false, detail: "navigation failed (transport error)" };
  if (nav.status === null) return { pass: false, detail: "no HTTP status" };
  const ok = nav.status >= 200 && nav.status < 300;
  return { pass: ok, detail: `HTTP ${nav.status}` };
}

function judgeConsole({ console }: SignalInput): { pass: boolean; detail: string } {
  const errors = console.filter((m) => m.type === "error");
  if (errors.length === 0) return { pass: true, detail: "no console errors" };
  const noun = errors.length === 1 ? "error" : "errors";
  return { pass: false, detail: `${errors.length} console ${noun}: ${errors[0]!.text}` };
}

function judgeSelector(
  { selectorsPresent }: SignalInput,
  { selectors }: SignalJudgeConfig,
): { pass: boolean; detail: string } {
  if (selectors.length === 0) return { pass: true, detail: "no required selectors" };
  const missing = selectors.filter((s) => !selectorsPresent[s]);
  if (missing.length === 0) {
    const noun = selectors.length === 1 ? "selector" : "selectors";
    return { pass: true, detail: `all ${selectors.length} ${noun} present` };
  }
  return { pass: false, detail: `missing: ${missing.join(", ")}` };
}

function judgePerf({ perf }: SignalInput, { perfBudget }: SignalJudgeConfig): { pass: boolean; detail: string } {
  const breaches: string[] = [];
  if (perf.lcpMs !== null && perf.lcpMs > perfBudget.lcpMs) {
    breaches.push(`LCP ${Math.round(perf.lcpMs)}ms > ${perfBudget.lcpMs}ms`);
  }
  if (perf.weightBytes > perfBudget.pageWeightBytes) {
    breaches.push(`weight ${kb(perf.weightBytes)} > ${kb(perfBudget.pageWeightBytes)}`);
  }
  if (perf.requestCount > perfBudget.maxRequests) {
    breaches.push(`${perf.requestCount} requests > ${perfBudget.maxRequests}`);
  }
  if (breaches.length > 0) return { pass: false, detail: breaches.join("; ") };
  const lcp = perf.lcpMs === null ? "LCP n/a" : `LCP ${Math.round(perf.lcpMs)}ms`;
  return { pass: true, detail: `${lcp}, ${kb(perf.weightBytes)}, ${perf.requestCount} requests` };
}

/** Render a byte count compactly for signal detail text. */
function kb(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}
