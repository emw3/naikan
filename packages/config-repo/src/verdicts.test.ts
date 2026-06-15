import { beforeEach, expect, test } from "bun:test";
import { createConfigRepo, ValidationError, type ConfigRepo } from "./repo.ts";
import { InMemoryConfigStore } from "./in-memory-store.ts";
import type { Actor } from "./types.ts";

// A controllable clock so verdict ordering (createdAt) is deterministic.
let clock: Date;
const now = () => clock;
let repo: ConfigRepo;
let runId: string;
const actor: Actor = { id: "user-1" };

beforeEach(async () => {
  clock = new Date("2026-06-08T00:00:00.000Z");
  repo = createConfigRepo(new InMemoryConfigStore(), { now });
  const project = await repo.createProject({ name: "Acme" }, actor);
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  const check = await repo.createUICheck({ siteId: site.id }, actor);
  const run = await repo.recordRun({
    checkId: check.id,
    checkType: "uicheck",
    startedAt: clock,
    finishedAt: clock,
    status: "fail",
    latencyMs: 1200,
    criticalFailed: false,
  });
  runId = run.id;
});

test("recordVerdict persists a verdict getLatestVerdict then returns", async () => {
  const v = await repo.recordVerdict({
    runId,
    verdict: "real_regression",
    confidence: 0.92,
    reasoning: "Nav bar collapsed on mobile; layout broke below 480px.",
    model: "claude-opus-4-8",
  });
  expect(v.id).toBeTruthy();
  expect(v.verdict).toBe("real_regression");
  expect(v.confidence).toBe(0.92);
  expect(v.model).toBe("claude-opus-4-8");

  const latest = await repo.getLatestVerdict(runId);
  expect(latest?.id).toBe(v.id);
});

test("getLatestVerdict returns the newest of several; listVerdicts is newest-first", async () => {
  await repo.recordVerdict({ runId, verdict: "noise", reasoning: "Carousel rotated.", model: "m1" });
  clock = new Date("2026-06-08T00:05:00.000Z");
  await repo.recordVerdict({ runId, verdict: "uncertain", reasoning: "Ambiguous.", model: "m2" });
  clock = new Date("2026-06-08T00:10:00.000Z");
  const newest = await repo.recordVerdict({
    runId,
    verdict: "real_regression",
    reasoning: "Hero image missing.",
    model: "m3",
  });

  const latest = await repo.getLatestVerdict(runId);
  expect(latest?.id).toBe(newest.id);
  expect(latest?.verdict).toBe("real_regression");

  const all = await repo.listVerdicts(runId);
  expect(all.map((v) => v.model)).toEqual(["m3", "m2", "m1"]);
});

test("getLatestVerdict / listVerdicts are empty for a run with no verdicts", async () => {
  expect(await repo.getLatestVerdict(runId)).toBeNull();
  expect(await repo.listVerdicts(runId)).toEqual([]);
});

test("confidence defaults to null when omitted", async () => {
  const v = await repo.recordVerdict({ runId, verdict: "noise", reasoning: "Timestamp text changed.", model: "m" });
  expect(v.confidence).toBeNull();
});

test("rejects an out-of-vocabulary verdict", async () => {
  await expect(
    repo.recordVerdict({ runId, verdict: "broken" as never, reasoning: "x", model: "m" }),
  ).rejects.toBeInstanceOf(ValidationError);
});

test("rejects empty reasoning and empty model", async () => {
  await expect(
    repo.recordVerdict({ runId, verdict: "noise", reasoning: "   ", model: "m" }),
  ).rejects.toThrow(/reasoning/i);
  await expect(
    repo.recordVerdict({ runId, verdict: "noise", reasoning: "ok", model: "  " }),
  ).rejects.toThrow(/model/i);
});

test("rejects a confidence outside 0..1", async () => {
  await expect(
    repo.recordVerdict({ runId, verdict: "noise", reasoning: "ok", model: "m", confidence: 1.5 }),
  ).rejects.toThrow(/confidence/i);
  await expect(
    repo.recordVerdict({ runId, verdict: "noise", reasoning: "ok", model: "m", confidence: -0.1 }),
  ).rejects.toThrow(/confidence/i);
});
