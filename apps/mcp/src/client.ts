/**
 * `NaikanApiClient` — a typed fetch wrapper over the Naikan HTTP API, carrying
 * the scoped agent bearer token on every request.
 *
 * This is the package's deep module: the MCP tool layer above it speaks only in
 * domain calls (`listUIChecks`, `getRun`, `submitVerdict`), never in URLs,
 * headers, or status codes. `fetch` is injected (defaulting to global `fetch`,
 * present on both Node ≥18 and Bun) so the client is unit-testable against a fake
 * without a live server — the same injected-dependency seam used by
 * `@naikan/heartbeat-runner`.
 */
import type {
  AgentVerdict,
  CheckRun,
  RunDetail,
  UICheckSummary,
  VerdictInput,
} from "./types.ts";

/** Minimal Response shape the client consumes (so a fake needn't be a full Response). */
export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** The injectable HTTP function — a structural subset of global `fetch`. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponse>;

/** The domain surface the MCP tools depend on (fake-implementable in tool tests). */
export interface NaikanApiClient {
  /** Every UI check visible to the agent (discovery endpoint). */
  listUIChecks(): Promise<UICheckSummary[]>;
  /** Recent runs for one check, newest first. */
  listRuns(checkId: string): Promise<CheckRun[]>;
  /** One run's full detail: presigned images, diff%, signals, latest verdict. */
  getRun(checkId: string, runId: string): Promise<RunDetail>;
  /** Record a verdict for a run; returns the persisted verdict. */
  submitVerdict(checkId: string, runId: string, input: VerdictInput): Promise<AgentVerdict>;
}

export interface ClientOptions {
  apiUrl: string;
  agentToken: string;
  /** Injected HTTP. Defaults to global `fetch`. */
  fetch?: FetchLike;
}

export function createClient(opts: ClientOptions): NaikanApiClient {
  const { apiUrl, agentToken } = opts;
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));

  /** Issue a request carrying the bearer token and parse the JSON response. */
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${agentToken}` };
    if (body !== undefined) headers["content-type"] = "application/json";

    const res = await doFetch(`${apiUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Naikan API ${method} ${path} failed: ${res.status} ${text}`.trim());
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  return {
    async listUIChecks() {
      const { checks } = await request<{ checks: UICheckSummary[] }>("GET", "/api/uichecks");
      return checks;
    },
    async listRuns(checkId) {
      const { runs } = await request<{ runs: CheckRun[] }>(
        "GET",
        `/api/uichecks/${encodeURIComponent(checkId)}/runs`,
      );
      return runs;
    },
    getRun(checkId, runId) {
      return request<RunDetail>(
        "GET",
        `/api/uichecks/${encodeURIComponent(checkId)}/runs/${encodeURIComponent(runId)}`,
      );
    },
    async submitVerdict(checkId, runId, input) {
      const { verdict } = await request<{ verdict: AgentVerdict }>(
        "POST",
        `/api/uichecks/${encodeURIComponent(checkId)}/runs/${encodeURIComponent(runId)}/verdict`,
        input,
      );
      return verdict;
    },
  };
}
