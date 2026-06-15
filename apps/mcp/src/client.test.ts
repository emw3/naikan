import { expect, test } from "bun:test";
import { createClient, type FetchLike, type FetchResponse } from "./client.ts";

/** A fake fetch that records the last call and returns a canned 200 JSON body. */
function recordingFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = [];
  const fetchLike: FetchLike = (url, init) => {
    calls.push({ url, ...init });
    const res: FetchResponse = {
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    };
    return Promise.resolve(res);
  };
  return { fetchLike, calls };
}

const BASE = "http://api.test";
const TOKEN = "agent-tok";

test("listUIChecks GETs /api/uichecks with the bearer token and unwraps {checks}", async () => {
  const { fetchLike, calls } = recordingFetch({ checks: [{ id: "c1", path: "/pricing" }] });
  const client = createClient({ apiUrl: BASE, agentToken: TOKEN, fetch: fetchLike });

  const checks = await client.listUIChecks();

  expect(checks).toEqual([{ id: "c1", path: "/pricing" }] as never);
  expect(calls[0].url).toBe("http://api.test/api/uichecks");
  expect(calls[0].method).toBe("GET");
  expect(calls[0].headers?.authorization).toBe("Bearer agent-tok");
});

test("listRuns GETs the per-check runs path and unwraps {runs}", async () => {
  const { fetchLike, calls } = recordingFetch({ runs: [{ id: "r1", status: "fail" }] });
  const client = createClient({ apiUrl: BASE, agentToken: TOKEN, fetch: fetchLike });

  const runs = await client.listRuns("c1");

  expect(runs).toEqual([{ id: "r1", status: "fail" }] as never);
  expect(calls[0].url).toBe("http://api.test/api/uichecks/c1/runs");
});

test("getRun GETs the run-detail path and returns the whole body", async () => {
  const detail = {
    run: { id: "r1" },
    screenshots: { desktop: "u1" },
    diffs: { desktop: { pct: 0.4, url: "u2" } },
    baseline: { desktop: "u3" },
    signals: {},
    verdict: null,
    expired: false,
  };
  const { fetchLike, calls } = recordingFetch(detail);
  const client = createClient({ apiUrl: BASE, agentToken: TOKEN, fetch: fetchLike });

  const got = await client.getRun("c1", "r1");

  expect(got).toEqual(detail as never);
  expect(calls[0].url).toBe("http://api.test/api/uichecks/c1/runs/r1");
});

test("submitVerdict POSTs the verdict body with content-type and unwraps {verdict}", async () => {
  const { fetchLike, calls } = recordingFetch({ verdict: { id: "v1", verdict: "real_regression" } });
  const client = createClient({ apiUrl: BASE, agentToken: TOKEN, fetch: fetchLike });

  const verdict = await client.submitVerdict("c1", "r1", {
    verdict: "real_regression",
    reasoning: "Nav collapsed.",
    confidence: 0.9,
    model: "claude-opus-4-8",
  });

  expect(verdict).toEqual({ id: "v1", verdict: "real_regression" } as never);
  expect(calls[0].url).toBe("http://api.test/api/uichecks/c1/runs/r1/verdict");
  expect(calls[0].method).toBe("POST");
  expect(calls[0].headers?.["content-type"]).toBe("application/json");
  expect(JSON.parse(calls[0].body!)).toMatchObject({ verdict: "real_regression", model: "claude-opus-4-8" });
});

test("a non-2xx response throws an error carrying the status and body", async () => {
  const { fetchLike } = recordingFetch({ error: "check not found" }, 404);
  const client = createClient({ apiUrl: BASE, agentToken: TOKEN, fetch: fetchLike });

  let err: Error | undefined;
  try {
    await client.listRuns("nope");
  } catch (e) {
    err = e as Error;
  }
  expect(err).toBeInstanceOf(Error);
  expect(err!.message).toContain("404");
  expect(err!.message).toContain("check not found");
});

test("path segments are URL-encoded", async () => {
  const { fetchLike, calls } = recordingFetch({ runs: [] });
  const client = createClient({ apiUrl: BASE, agentToken: TOKEN, fetch: fetchLike });

  await client.listRuns("a/b c");
  expect(calls[0].url).toBe("http://api.test/api/uichecks/a%2Fb%20c/runs");
});
