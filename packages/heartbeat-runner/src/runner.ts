/**
 * `heartbeat-runner` — pure executor for a HeartbeatCheck.
 *
 * Runs up to four independent signals against a target and aggregates them into
 * one pass/fail `CheckRunResult`:
 *   - HTTP   — GET base+path; non-2xx (or a transport error) fails.
 *   - body   — regex match or JSON dot-path assertion on the response body.
 *   - DNS    — hostname resolves to ≥1 address.
 *   - cert   — TLS peer certificate is not expired (https only).
 *
 * Signals run independently and every failure is collected, so one run reports
 * all the reasons it failed (not just the first). Side-effects are injected via
 * `RunnerDeps`, defaulting to live Node/Bun implementations.
 */
import type { BodyAssertion, CheckRunResult, FetchResponse, HeartbeatSpec, RunnerDeps } from "./types.ts";

const FETCH_TIMEOUT_MS = 15_000;
const TLS_TIMEOUT_MS = 10_000;

export async function runHeartbeat(
  baseUrl: string,
  spec: HeartbeatSpec,
  deps: RunnerDeps = {},
): Promise<CheckRunResult> {
  const now = deps.now ?? (() => new Date());
  const doFetch = deps.fetch ?? liveFetch;
  const resolveDns = deps.resolveDns ?? liveResolveDns;
  const inspectCert = deps.inspectCert ?? liveInspectCert;

  const url = new URL(spec.path, baseUrl);
  const errors: string[] = [];
  const startedAt = now();

  if (spec.dnsCheck) {
    try {
      const addrs = await resolveDns(url.hostname);
      if (!addrs.length) errors.push(`DNS: no addresses for ${url.hostname}`);
    } catch (err) {
      errors.push(`DNS: resolution failed for ${url.hostname} (${message(err)})`);
    }
  }

  try {
    const res = await doFetch(url.toString());
    if (!res.ok) errors.push(`HTTP ${res.status}`);
    if (spec.bodyAssertion) {
      const body = await res.text();
      if (!assertBody(spec.bodyAssertion, body)) {
        errors.push(`body assertion failed (${describeAssertion(spec.bodyAssertion)})`);
      }
    }
  } catch (err) {
    errors.push(`request failed: ${message(err)}`);
  }

  if (spec.certCheck) {
    if (url.protocol !== "https:") {
      errors.push("certificate check requires https");
    } else {
      try {
        const port = url.port ? Number(url.port) : 443;
        const { validTo } = await inspectCert(url.hostname, port);
        if (now().getTime() > validTo.getTime()) {
          errors.push(`certificate expired ${validTo.toISOString()}`);
        }
      } catch (err) {
        errors.push(`certificate check failed: ${message(err)}`);
      }
    }
  }

  const finishedAt = now();
  return {
    status: errors.length ? "fail" : "pass",
    startedAt,
    finishedAt,
    latencyMs: finishedAt.getTime() - startedAt.getTime(),
    error: errors.length ? errors.join("; ") : null,
  };
}

// ---- body assertion ----

function assertBody(assertion: BodyAssertion, body: string): boolean {
  if (assertion.kind === "regex") {
    try {
      return new RegExp(assertion.pattern).test(body);
    } catch {
      return false; // an unparseable pattern is a failed assertion, not a crash
    }
  }
  // jsonpath
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const value = resolvePath(parsed, assertion.pattern);
  if (value === undefined || value === null) return false;
  if (assertion.equals !== undefined) return String(value) === assertion.equals;
  return true;
}

/** Resolves a dot-delimited path (`data.health`, `items.0.id`) in parsed JSON. */
function resolvePath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
    if (cur === undefined) return undefined;
  }
  return cur;
}

function describeAssertion(a: BodyAssertion): string {
  if (a.kind === "regex") return `regex /${a.pattern}/`;
  return a.equals !== undefined ? `${a.pattern} == ${a.equals}` : `${a.pattern} present`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---- live (Node/Bun) default implementations ----

async function liveFetch(url: string): Promise<FetchResponse> {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return res;
}

async function liveResolveDns(hostname: string): Promise<string[]> {
  const dns = await import("node:dns/promises");
  // `lookup` honours the host's resolver (hosts file + DNS), matching real reachability.
  const results = await dns.lookup(hostname, { all: true });
  return results.map((r: { address: string }) => r.address);
}

async function liveInspectCert(hostname: string, port: number): Promise<{ validTo: Date }> {
  const tls = await import("node:tls");
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: hostname, port, servername: hostname, timeout: TLS_TIMEOUT_MS },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) {
          reject(new Error("no peer certificate"));
          return;
        }
        resolve({ validTo: new Date(cert.valid_to) });
      },
    );
    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("TLS connection timed out"));
    });
  });
}
