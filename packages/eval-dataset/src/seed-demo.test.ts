/**
 * Smoke test for the demo-seed persistence wiring (issue #05). The seed itself is
 * an integration script (it drives the real browser + Postgres + S3, not unit-
 * tested per the PRD), but its persistence logic mirrors `runUIJob` + the promote
 * route — so this test pins that wiring through the same injected-dependency seams
 * the worker tests use (`InMemoryConfigStore` + a recording fake store + a stub
 * runner), with no browser, Postgres, or S3.
 */
import { describe, expect, test } from "bun:test";
import { createConfigRepo, InMemoryConfigStore, type ConfigRepo } from "@naikan/config-repo";
import type { UIRunResult } from "@naikan/ui-runner";
import { seedDemo, type RunUIFn } from "./seed-demo.ts";
import { SEED_CASES } from "./cases.ts";

/** Records every put so the test can assert which artifacts were written. */
function fakeStore() {
  const puts: Array<{ key: string; contentType: string }> = [];
  return {
    puts,
    put(key: string, _body: Buffer, contentType: string): Promise<void> {
      puts.push({ key, contentType });
      return Promise.resolve();
    },
  };
}

/** One passing signal set + one fake screenshot; a diff only when a baseline is supplied. */
const stubRunUI: RunUIFn = (_config, baseline) => {
  const result: UIRunResult = {
    artifacts: [{ viewport: "desktop", screenshot: Buffer.from("png"), dims: { w: 1440, h: 900 } }],
    signals: [
      {
        viewport: "desktop",
        signals: [
          { kind: "load", pass: true, severity: "critical", detail: "HTTP 200" },
          { kind: "console", pass: true, severity: "warning", detail: "no console errors" },
          { kind: "selector", pass: true, severity: "warning", detail: "no required selectors" },
          { kind: "perf", pass: true, severity: "warning", detail: "ok" },
        ],
      },
    ],
    diffs: baseline
      ? [{ viewport: "desktop", pct: 0.1, regressed: true, dimensionMismatch: false, diff: Buffer.from("diff") }]
      : [],
  };
  return Promise.resolve(result);
};

describe("seedDemo", () => {
  test("creates the demo project, one check per case, each with a promoted baseline + 2 runs", async () => {
    const repo: ConfigRepo = createConfigRepo(new InMemoryConfigStore());
    const store = fakeStore();

    const { projectId, checkIds } = await seedDemo({ repo, store }, "http://seed.local", stubRunUI, () => {});

    expect(checkIds.length).toBe(SEED_CASES.length);

    const projects = await repo.listProjects();
    expect(projects.some((p) => p.id === projectId && p.name === "Naikan Demo")).toBe(true);

    for (const checkId of checkIds) {
      const check = await repo.getUICheck(checkId);
      // Baseline was promoted (points at the baseline manifest key).
      expect(check?.baselineImageRef).toContain(`/baseline/manifest.json`);

      // Two runs: the baseline-state run (pass) and the current diff run (fail).
      const runs = await repo.listRuns(checkId);
      expect(runs.length).toBe(2);
      const statuses = runs.map((r) => r.status).sort();
      expect(statuses).toEqual(["fail", "pass"]);
      expect(runs.every((r) => r.artifactsRef?.includes("manifest.json"))).toBe(true);
    }
  });

  test("writes baseline, screenshot, diff overlay, and manifest artifacts", async () => {
    const repo: ConfigRepo = createConfigRepo(new InMemoryConfigStore());
    const store = fakeStore();
    const { checkIds } = await seedDemo({ repo, store }, "http://seed.local", stubRunUI, () => {});

    const keys = store.puts.map((p) => p.key);
    const first = checkIds[0];
    expect(keys.some((k) => k.includes(`/checks/${first}/baseline/desktop.png`))).toBe(true);
    expect(keys.some((k) => k.includes(`/checks/${first}/baseline/manifest.json`))).toBe(true);
    expect(keys.some((k) => k.includes(`/checks/${first}/runs/`) && k.endsWith("desktop.png"))).toBe(true);
    expect(keys.some((k) => k.includes(`/checks/${first}/runs/`) && k.endsWith("desktop.diff.png"))).toBe(true);
    expect(keys.some((k) => k.includes(`/checks/${first}/runs/`) && k.endsWith("manifest.json"))).toBe(true);

    // PNG artifacts declared image/png; manifests application/json.
    const png = store.puts.find((p) => p.key.endsWith(".png"));
    expect(png?.contentType).toBe("image/png");
    const manifest = store.puts.find((p) => p.key.endsWith("manifest.json"));
    expect(manifest?.contentType).toBe("application/json");
  });
});
