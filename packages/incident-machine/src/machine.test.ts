import { expect, test } from "bun:test";
import { evaluateIncident, replayIncidents, SUCCESSES_TO_CLOSE } from "./machine.ts";
import type { RunPoint, Transition } from "./types.ts";

/** Epoch + the given number of seconds, as a Date. */
const at = (seconds: number): Date => new Date(seconds * 1000);
const fail = (seconds: number): RunPoint => ({ status: "fail", startedAt: at(seconds) });
const pass = (seconds: number): RunPoint => ({ status: "pass", startedAt: at(seconds) });
/** The `kind` sequence — the shape most table cases assert on. */
const kinds = (ts: Transition[]): string[] => ts.map((t) => t.kind);

test("M (successes to close) is the hard-coded 2 from the issue", () => {
  expect(SUCCESSES_TO_CLOSE).toBe(2);
});

// ---- the four named cases from the issue ----

test("clean 2-success close (N=2): none, opened, still-open, closed-recovered", () => {
  const ts = replayIncidents([fail(0), fail(60), pass(120), pass(180)], 2);
  expect(kinds(ts)).toEqual(["none", "opened", "still-open", "closed-recovered"]);
  const opened = ts[1] as Extract<Transition, { kind: "opened" }>;
  expect(opened.openedAt).toEqual(at(0)); // first fail of the streak
  const closed = ts[3] as Extract<Transition, { kind: "closed-recovered" }>;
  expect(closed.openedAt).toEqual(at(0));
  expect(closed.closedAt).toEqual(at(180)); // the 2nd success that confirmed recovery
  expect(closed.durationMs).toBe(180_000);
});

test("flap-open-then-recover (N=1): opens immediately, recovers after two successes", () => {
  const ts = replayIncidents([fail(0), pass(30), pass(60)], 1);
  expect(kinds(ts)).toEqual(["opened", "still-open", "closed-recovered"]);
  const closed = ts[2] as Extract<Transition, { kind: "closed-recovered" }>;
  expect(closed.durationMs).toBe(60_000);
});

test("sustained outage (N=2): opens once, then stays open across further fails", () => {
  const ts = replayIncidents([fail(0), fail(60), fail(120), fail(180)], 2);
  expect(kinds(ts)).toEqual(["none", "opened", "still-open", "still-open"]);
});

test("false flap with a success between fails (N=2) never opens", () => {
  const ts = replayIncidents([fail(0), pass(30), fail(60), pass(90), fail(120)], 2);
  expect(kinds(ts)).toEqual(["none", "none", "none", "none", "none"]);
});

// ---- edges ----

test("empty history yields no transitions", () => {
  expect(replayIncidents([], 2)).toEqual([]);
});

test("a single success while open is not enough to close", () => {
  const ts = replayIncidents([fail(0), pass(30)], 1);
  expect(kinds(ts)).toEqual(["opened", "still-open"]);
});

test("an incident can reopen after a clean recovery (N=1)", () => {
  const ts = replayIncidents([fail(0), pass(30), pass(60), fail(120)], 1);
  expect(kinds(ts)).toEqual(["opened", "still-open", "closed-recovered", "opened"]);
  const reopened = ts[3] as Extract<Transition, { kind: "opened" }>;
  expect(reopened.openedAt).toEqual(at(120));
});

// ---- single-step contract (what the orchestrator calls) ----

test("evaluateIncident opens when the trailing fails reach the threshold", () => {
  const t = evaluateIncident({ runs: [fail(0), fail(60)], open: null, alertAfterNFails: 2 });
  expect(t).toEqual({ kind: "opened", openedAt: at(0) });
});

test("evaluateIncident closes an open incident on two trailing passes", () => {
  const t = evaluateIncident({
    runs: [pass(120), pass(180)],
    open: { openedAt: at(0) },
    alertAfterNFails: 2,
  });
  expect(t).toEqual({ kind: "closed-recovered", openedAt: at(0), closedAt: at(180), durationMs: 180_000 });
});
