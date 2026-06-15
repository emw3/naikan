/**
 * Worker UI job handler (issue #11b): the queue invokes `runUIJob`, which drives
 * `@naikan/ui-runner`, persists the per-viewport PNGs + a run manifest via
 * `@naikan/baseline-store`, and records a uicheck CheckRun referencing the
 * manifest key. The runner + store are injected so the handler is testable
 * without a real browser or S3.
 */
import { beforeEach, expect, test } from "bun:test";
import { createConfigRepo, InMemoryConfigStore, type Actor, type ConfigRepo } from "@naikan/config-repo";
import { artifactKeys } from "@naikan/baseline-store";
import { runUIJob, type RunUI } from "./ui-job.ts";

const actor: Actor = { id: "system" };

let repo: ConfigRepo;
let siteId: string;
let projectId: string;

beforeEach(async () => {
  repo = createConfigRepo(new InMemoryConfigStore());
  const project = await repo.createProject({ name: "Acme" }, actor);
  projectId = project.id;
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  siteId = site.id;
});

/**
 * Records every put() and serves get() from what was put — so a test can both
 * assert which artifacts were written and seed a baseline for the runner to load.
 */
function fakeStore() {
  const puts: Array<{ key: string; body: Buffer; contentType: string }> = [];
  const objects: Record<string, Buffer> = {};
  return {
    puts,
    objects,
    put(key: string, body: Buffer, contentType: string): Promise<void> {
      puts.push({ key, body, contentType });
      objects[key] = body;
      return Promise.resolve();
    },
    get(key: string): Promise<Buffer> {
      return objects[key] ? Promise.resolve(objects[key]) : Promise.reject(new Error(`missing ${key}`));
    },
  };
}

/** A runUI stub that returns one fake screenshot per requested viewport and no diffs. */
const fakeRunUI: RunUI = (config) =>
  Promise.resolve({
    signals: [],
    diffs: [],
    artifacts: config.viewports.map((v) => ({
      viewport: v.label,
      screenshot: Buffer.from(`png-${v.label}`),
      dims: { w: v.width, h: v.height },
    })),
  });

test("runUIJob writes a PNG per viewport + a manifest and records a uicheck CheckRun", async () => {
  const check = await repo.createUICheck({ siteId, path: "/pricing" }, actor); // default 3 viewports
  const store = fakeStore();

  const run = await runUIJob(check.id, { repo, store, runUI: fakeRunUI, genId: () => "run-1" });

  // One PNG per viewport, content-typed image/png.
  for (const vp of ["mobile", "tablet", "desktop"]) {
    const key = artifactKeys.runScreenshot(projectId, check.id, "run-1", vp);
    const put = store.puts.find((p) => p.key === key);
    expect(put).toBeDefined();
    expect(put!.contentType).toBe("image/png");
  }

  // A manifest written under the run subtree, content-typed application/json.
  const manifestKey = artifactKeys.runManifest(projectId, check.id, "run-1");
  const manifestPut = store.puts.find((p) => p.key === manifestKey);
  expect(manifestPut).toBeDefined();
  expect(manifestPut!.contentType).toBe("application/json");
  const manifest = JSON.parse(manifestPut!.body.toString());
  expect(manifest.runId).toBe("run-1");
  expect(manifest.viewports).toEqual(["mobile", "tablet", "desktop"]);
  expect(manifest.screenshots.desktop).toBe(
    artifactKeys.runScreenshot(projectId, check.id, "run-1", "desktop"),
  );

  // The CheckRun is a uicheck run referencing the manifest key.
  expect(run?.checkType).toBe("uicheck");
  expect(run?.status).toBe("pass");
  expect(run?.artifactsRef).toBe(manifestKey);
  expect(await repo.listRuns(check.id)).toHaveLength(1);
});

test("runUIJob drives runUI at the site base URL joined with the check path", async () => {
  const check = await repo.createUICheck({ siteId, path: "/pricing" }, actor);
  const store = fakeStore();
  const seenUrls: string[] = [];
  const spy: RunUI = (config) => {
    seenUrls.push(config.url);
    return fakeRunUI(config);
  };

  await runUIJob(check.id, { repo, store, runUI: spy, genId: () => "run-1" });

  expect(seenUrls).toEqual(["https://acme.test/pricing"]);
});

test("runUIJob captures only the check's configured viewports", async () => {
  const check = await repo.createUICheck({ siteId, path: "/", viewports: ["desktop"] }, actor);
  const store = fakeStore();

  await runUIJob(check.id, { repo, store, runUI: fakeRunUI, genId: () => "run-2" });

  const pngPuts = store.puts.filter((p) => p.key.endsWith(".png"));
  expect(pngPuts).toHaveLength(1);
  expect(pngPuts[0]!.key).toBe(artifactKeys.runScreenshot(projectId, check.id, "run-2", "desktop"));
});

test("runUIJob returns null for an unknown check and writes nothing", async () => {
  const store = fakeStore();
  const run = await runUIJob("missing", { repo, store, runUI: fakeRunUI, genId: () => "run-3" });
  expect(run).toBeNull();
  expect(store.puts).toHaveLength(0);
});

// ---- baseline diffing (#12) ----

/** Seed an approved baseline (manifest + one buffer per viewport) for `check`. */
async function seedBaseline(checkId: string, viewports: string[]) {
  const screenshots: Record<string, string> = {};
  const store = fakeStore();
  for (const vp of viewports) {
    const key = artifactKeys.baseline(projectId, checkId, vp);
    store.objects[key] = Buffer.from(`baseline-${vp}`);
    screenshots[vp] = key;
  }
  const manifestKey = artifactKeys.baselineManifest(projectId, checkId);
  store.objects[manifestKey] = Buffer.from(JSON.stringify({ promotedFromRunId: "old", screenshots }));
  await repo.updateUICheck(checkId, { baselineImageRef: manifestKey }, actor);
  return store;
}

test("runUIJob loads the baseline and passes it + the check's diff config to runUI", async () => {
  const check = await repo.createUICheck(
    { siteId, path: "/", viewports: ["desktop"], ignoreRegions: [".banner"], diffThreshold: 0.05 },
    actor,
  );
  const store = await seedBaseline(check.id, ["desktop"]);
  let seen: { baseline?: unknown; ignoreRegions?: string[]; diffThreshold?: number } = {};
  const spy: RunUI = (config, baseline) => {
    seen = { baseline, ignoreRegions: config.ignoreRegions, diffThreshold: config.diffThreshold };
    return fakeRunUI(config);
  };

  await runUIJob(check.id, { repo, store, runUI: spy, genId: () => "run-1" });

  expect(seen.ignoreRegions).toEqual([".banner"]);
  expect(seen.diffThreshold).toBe(0.05);
  expect((seen.baseline as { screenshots: Record<string, Buffer> }).screenshots.desktop.toString()).toBe(
    "baseline-desktop",
  );
});

test("runUIJob uploads a diff PNG per viewport and records pct + key in the manifest", async () => {
  const check = await repo.createUICheck({ siteId, path: "/", viewports: ["desktop"] }, actor);
  const store = await seedBaseline(check.id, ["desktop"]);
  const diffingRunUI: RunUI = (config) =>
    Promise.resolve({
      signals: [],
      artifacts: config.viewports.map((v) => ({
        viewport: v.label,
        screenshot: Buffer.from(`png-${v.label}`),
        dims: { w: v.width, h: v.height },
      })),
      diffs: [{ viewport: "desktop", pct: 0.12, regressed: true, dimensionMismatch: false, diff: Buffer.from("diff-png") }],
    });

  const run = await runUIJob(check.id, { repo, store, runUI: diffingRunUI, genId: () => "run-1" });

  const diffKey = artifactKeys.runDiff(projectId, check.id, "run-1", "desktop");
  const diffPut = store.puts.find((p) => p.key === diffKey);
  expect(diffPut).toBeDefined();
  expect(diffPut!.contentType).toBe("image/png");

  const manifestKey = artifactKeys.runManifest(projectId, check.id, "run-1");
  const manifest = JSON.parse(store.puts.find((p) => p.key === manifestKey)!.body.toString());
  expect(manifest.diffs.desktop).toEqual({ pct: 0.12, key: diffKey });

  // Any regressed viewport fails the run's visual signal.
  expect(run?.status).toBe("fail");
});

test("runUIJob records a fail with no diff key when a viewport's dimensions mismatched", async () => {
  const check = await repo.createUICheck({ siteId, path: "/", viewports: ["desktop"] }, actor);
  const store = await seedBaseline(check.id, ["desktop"]);
  const mismatchRunUI: RunUI = (config) =>
    Promise.resolve({
      signals: [],
      artifacts: config.viewports.map((v) => ({
        viewport: v.label,
        screenshot: Buffer.from(`png-${v.label}`),
        dims: { w: v.width, h: v.height },
      })),
      diffs: [{ viewport: "desktop", pct: 1, regressed: true, dimensionMismatch: true }],
    });

  const run = await runUIJob(check.id, { repo, store, runUI: mismatchRunUI, genId: () => "run-1" });

  // No overlay exists on a dimension mismatch — manifest records pct only, no key.
  const manifestKey = artifactKeys.runManifest(projectId, check.id, "run-1");
  const manifest = JSON.parse(store.puts.find((p) => p.key === manifestKey)!.body.toString());
  expect(manifest.diffs.desktop).toEqual({ pct: 1 });
  expect(store.puts.some((p) => p.key.endsWith(".diff.png"))).toBe(false);
  expect(run?.status).toBe("fail");
});

test("runUIJob records a pass when diffs stay within threshold", async () => {
  const check = await repo.createUICheck({ siteId, path: "/", viewports: ["desktop"] }, actor);
  const store = await seedBaseline(check.id, ["desktop"]);
  const cleanRunUI: RunUI = (config) =>
    Promise.resolve({
      signals: [],
      artifacts: config.viewports.map((v) => ({
        viewport: v.label,
        screenshot: Buffer.from(`png-${v.label}`),
        dims: { w: v.width, h: v.height },
      })),
      diffs: [{ viewport: "desktop", pct: 0, regressed: false, dimensionMismatch: false, diff: Buffer.from("diff-png") }],
    });

  const run = await runUIJob(check.id, { repo, store, runUI: cleanRunUI, genId: () => "run-1" });
  expect(run?.status).toBe("pass");
});

// ---- synthetic signals (#13) ----

/** A runUI stub returning one screenshot per viewport plus caller-supplied per-viewport signals. */
function signalsRunUI(signalsByViewport: Record<string, Array<{ kind: string; pass: boolean; severity: string; detail: string }>>): RunUI {
  return (config) =>
    Promise.resolve({
      signals: config.viewports.map((v) => ({ viewport: v.label, signals: (signalsByViewport[v.label] ?? []) as never })),
      diffs: [],
      artifacts: config.viewports.map((v) => ({
        viewport: v.label,
        screenshot: Buffer.from(`png-${v.label}`),
        dims: { w: v.width, h: v.height },
      })),
    });
}

test("runUIJob writes per-viewport judged signals into the manifest", async () => {
  const check = await repo.createUICheck({ siteId, path: "/", viewports: ["desktop"] }, actor);
  const store = fakeStore();
  const signals = [
    { kind: "load", pass: true, severity: "critical", detail: "HTTP 200" },
    { kind: "console", pass: false, severity: "warning", detail: "1 console error: ReferenceError: x is not defined" },
    { kind: "selector", pass: true, severity: "warning", detail: "no required selectors" },
    { kind: "perf", pass: true, severity: "warning", detail: "LCP 800ms, 1KB, 4 requests" },
  ];

  await runUIJob(check.id, { repo, store, runUI: signalsRunUI({ desktop: signals }), genId: () => "run-1" });

  const manifestKey = artifactKeys.runManifest(projectId, check.id, "run-1");
  const manifest = JSON.parse(store.puts.find((p) => p.key === manifestKey)!.body.toString());
  expect(manifest.signals.desktop).toEqual(signals);
});

test("runUIJob fails the run when any signal failed, even a warning", async () => {
  const check = await repo.createUICheck({ siteId, path: "/", viewports: ["desktop"] }, actor);
  const store = fakeStore();
  const signals = [
    { kind: "load", pass: true, severity: "critical", detail: "HTTP 200" },
    { kind: "console", pass: false, severity: "warning", detail: "1 console error: boom" },
    { kind: "selector", pass: true, severity: "warning", detail: "no required selectors" },
    { kind: "perf", pass: true, severity: "warning", detail: "ok" },
  ];

  const run = await runUIJob(check.id, { repo, store, runUI: signalsRunUI({ desktop: signals }), genId: () => "run-1" });
  expect(run?.status).toBe("fail");
});

test("runUIJob records a pass when every signal passed and no diff regressed", async () => {
  const check = await repo.createUICheck({ siteId, path: "/", viewports: ["desktop"] }, actor);
  const store = fakeStore();
  const signals = [
    { kind: "load", pass: true, severity: "critical", detail: "HTTP 200" },
    { kind: "console", pass: true, severity: "warning", detail: "no console errors" },
    { kind: "selector", pass: true, severity: "warning", detail: "no required selectors" },
    { kind: "perf", pass: true, severity: "warning", detail: "ok" },
  ];

  const run = await runUIJob(check.id, { repo, store, runUI: signalsRunUI({ desktop: signals }), genId: () => "run-1" });
  expect(run?.status).toBe("pass");
});

test("runUIJob passes the check's selectors, perf budget, and per-signal severities to runUI", async () => {
  const check = await repo.createUICheck(
    {
      siteId,
      path: "/",
      viewports: ["desktop"],
      selectors: ["#hero", ".cta"],
      perfBudget: { lcpMs: 1800, pageWeightBytes: 1_000_000, maxRequests: 50 },
      severityConsole: "critical",
    },
    actor,
  );
  const store = fakeStore();
  let seen: Parameters<RunUI>[0] | null = null;
  const spy: RunUI = (config) => {
    seen = config;
    return signalsRunUI({})(config);
  };

  await runUIJob(check.id, { repo, store, runUI: spy, genId: () => "run-1" });

  expect(seen!.selectors).toEqual(["#hero", ".cta"]);
  expect(seen!.perfBudget).toEqual({ lcpMs: 1800, pageWeightBytes: 1_000_000, maxRequests: 50 });
  expect(seen!.severities).toEqual({ load: "critical", console: "critical", selector: "warning", perf: "warning" });
});
