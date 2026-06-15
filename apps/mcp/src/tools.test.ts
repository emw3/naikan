import { expect, test } from "bun:test";
import { getUiRun, listUiChecks, listUiRuns, submitVerdict } from "./tools.ts";
import type { NaikanApiClient } from "./client.ts";
import type { AgentVerdict, CheckRun, RunDetail, UICheckSummary, VerdictInput } from "./types.ts";

/**
 * A fake client that records every call, then delegates to an override impl if
 * one is supplied (else returns a canned default). Recording always happens, so a
 * test can both assert the call and pin the returned value.
 */
function fakeClient(over: Partial<NaikanApiClient> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const wrap = <K extends keyof NaikanApiClient>(method: K, fallback: unknown) =>
    ((...args: unknown[]) => {
      calls.push({ method, args });
      const impl = over[method] as ((...a: unknown[]) => Promise<unknown>) | undefined;
      return impl ? impl(...args) : Promise.resolve(fallback);
    }) as NaikanApiClient[K];
  const client: NaikanApiClient = {
    listUIChecks: wrap("listUIChecks", [] as UICheckSummary[]),
    listRuns: wrap("listRuns", [] as CheckRun[]),
    getRun: wrap("getRun", {} as RunDetail),
    submitVerdict: wrap("submitVerdict", {} as AgentVerdict),
  };
  return { client, calls };
}

const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;

test("list_ui_checks calls the client and returns the result as JSON text", async () => {
  const { client, calls } = fakeClient({
    listUIChecks: () => Promise.resolve([{ id: "c1", path: "/pricing" }] as UICheckSummary[]),
  });
  const res = await listUiChecks(client);
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(text(res))).toEqual([{ id: "c1", path: "/pricing" }]);
  expect(calls[0].method).toBe("listUIChecks");
});

test("list_ui_runs passes the checkId through to the client", async () => {
  const { client, calls } = fakeClient();
  await listUiRuns(client, { checkId: "c1" });
  expect(calls[0]).toEqual({ method: "listRuns", args: ["c1"] });
});

test("get_ui_run passes checkId + runId and returns the detail body", async () => {
  const detail = { run: { id: "r1" }, screenshots: {}, diffs: {}, baseline: {}, signals: {}, verdict: null, expired: false } as unknown as RunDetail;
  const { client, calls } = fakeClient({ getRun: () => Promise.resolve(detail) });
  const res = await getUiRun(client, { checkId: "c1", runId: "r1" });
  expect(calls[0]).toEqual({ method: "getRun", args: ["c1", "r1"] });
  expect(JSON.parse(text(res))).toMatchObject({ run: { id: "r1" }, expired: false });
});

test("submit_verdict maps args to the client's verdict input shape", async () => {
  const { client, calls } = fakeClient({
    submitVerdict: (_c, _r, input) => Promise.resolve({ id: "v1", verdict: input.verdict } as AgentVerdict),
  });
  const res = await submitVerdict(client, {
    checkId: "c1",
    runId: "r1",
    verdict: "noise",
    reasoning: "Timestamp ticked.",
    confidence: 0.8,
    model: "claude-opus-4-8",
  });
  expect(res.isError).toBeUndefined();
  expect(calls[0].method).toBe("submitVerdict");
  expect(calls[0].args).toEqual([
    "c1",
    "r1",
    { verdict: "noise", reasoning: "Timestamp ticked.", confidence: 0.8, model: "claude-opus-4-8" },
  ]);
});

test("submit_verdict defaults an omitted confidence to null", async () => {
  const { client, calls } = fakeClient();
  await submitVerdict(client, { checkId: "c1", runId: "r1", verdict: "uncertain", reasoning: "Unsure.", model: "m" });
  expect((calls[0].args[2] as VerdictInput).confidence).toBeNull();
});

test("a client error surfaces as a tool error carrying the message", async () => {
  const { client } = fakeClient({
    listRuns: () => Promise.reject(new Error("404 check not found")),
  });
  const res = await listUiRuns(client, { checkId: "nope" });
  expect(res.isError).toBe(true);
  expect(text(res)).toContain("404 check not found");
});
