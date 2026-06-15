/**
 * Types for `heartbeat-runner` — the pure executor that turns a HeartbeatCheck
 * config into a CheckRun result. The runner wraps four independent signals
 * (HTTP status, body assertion, DNS resolution, SSL cert expiry) and aggregates
 * them into a single pass/fail with an error summary.
 *
 * All side-effecting work (fetch, DNS, TLS, clock) is injected via `RunnerDeps`
 * so the core logic is deterministic and unit-testable against stubs.
 */

/** How to assert on the response body. */
export interface BodyAssertion {
  /** `regex` matches the raw body; `jsonpath` resolves a dot-path in parsed JSON. */
  kind: "regex" | "jsonpath";
  /** Regex source (kind=regex) or dot-path like `data.status` (kind=jsonpath). */
  pattern: string;
  /**
   * jsonpath only: the resolved value must equal this string (compared as `String(value)`).
   * Omitted → the path need only resolve to a non-null/non-undefined value.
   */
  equals?: string;
}

/** The subset of a HeartbeatCheck the runner needs to execute one run. */
export interface HeartbeatSpec {
  /** Request path appended to the site base URL, e.g. `/health`. */
  path: string;
  /** Optional response-body assertion. Null/undefined → not checked. */
  bodyAssertion?: BodyAssertion | null;
  /** Inspect the TLS certificate expiry (https only). */
  certCheck: boolean;
  /** Resolve the hostname via DNS. */
  dnsCheck: boolean;
}

export type CheckStatus = "pass" | "fail";

/** The outcome of one heartbeat run — shape mirrors the persisted CheckRun. */
export interface CheckRunResult {
  status: CheckStatus;
  startedAt: Date;
  finishedAt: Date;
  /** Wall-clock duration of the run in milliseconds. */
  latencyMs: number;
  /** Aggregated failure reasons (`; `-joined), or null when the run passed. */
  error: string | null;
}

/** Minimal Response shape the runner consumes (so a stub needn't be a full Response). */
export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** Injectable side-effects. Each defaults to a live Node/Bun implementation. */
export interface RunnerDeps {
  /** HTTP GET. Defaults to global `fetch` with a timeout. */
  fetch?: (url: string) => Promise<FetchResponse>;
  /** Resolve a hostname to one or more addresses. Defaults to `node:dns` lookup. */
  resolveDns?: (hostname: string) => Promise<string[]>;
  /** Inspect a TLS peer certificate. Defaults to a `node:tls` connection. */
  inspectCert?: (hostname: string, port: number) => Promise<{ validTo: Date }>;
  /** Clock, injectable for deterministic latency in tests. */
  now?: () => Date;
}
