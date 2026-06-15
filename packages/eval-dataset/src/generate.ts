/**
 * Synthetic corpus generator (issue #05). Boots the seed-page server, then for
 * each case in `SEED_CASES` drives the **real** `@naikan/ui-runner` pipeline
 * twice — once for the baseline state, once for the current state with that
 * baseline supplied — so the diff overlay, diff%, and Signals are genuine
 * pipeline output, not hand-mocked images. Labels are known by construction.
 *
 * Node-only (drives Playwright via ui-runner → capture). Run it:
 *
 *   node packages/eval-dataset/src/generate.ts
 *   # or:  bun run eval:generate
 *
 * Writes `fixtures/synthetic/<id>/{baseline,current,diff}.png` and upserts the
 * synthetic half of `fixtures/manifest.json`, preserving curated entries.
 */
import { runUI, resolveViewports, type Baseline, type UIRunConfig } from "@naikan/ui-runner";
import type { VerdictKind } from "@naikan/config-repo";
import { SEED_CASES, type SeedCase } from "./cases.ts";
import { pageUrl, startSeedServer } from "./server.ts";
import { FIXTURES_ROOT, toFixtureSignals, upsertBySource, writeFixtureImages } from "./corpus.ts";
import type { Label, ManifestFixture } from "./types.ts";

// Compile-time guard: the fixture Label vocabulary must stay identical to the
// agent's VerdictKind (whose single source of truth is config-repo's DB CHECK +
// repo validation). If either drifts, this assignment stops type-checking.
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _labelMatchesVerdict: Mutual<Label, VerdictKind> = true;
void _labelMatchesVerdict;

/** Capture one case through the pipeline → a labeled manifest entry. */
async function captureCase(origin: string, c: SeedCase): Promise<ManifestFixture> {
  const [viewport] = resolveViewports([c.viewport]);

  // Baseline state: no baseline supplied → capture only (this IS the baseline).
  const baselineCfg: UIRunConfig = {
    url: pageUrl(origin, c.page, c.baselineQuery),
    viewports: [viewport],
    diffThreshold: 0,
  };
  const baselineRun = await runUI(baselineCfg);
  const baselineShot = baselineRun.artifacts[0].screenshot;

  // Current state: diff against the baseline we just captured → genuine overlay.
  const currentCfg: UIRunConfig = {
    url: pageUrl(origin, c.page, c.currentQuery),
    viewports: [viewport],
    diffThreshold: 0,
  };
  const baseline: Baseline = { screenshots: { [viewport.label]: baselineShot } };
  const currentRun = await runUI(currentCfg, baseline);
  const currentShot = currentRun.artifacts[0].screenshot;
  const diff = currentRun.diffs[0];
  const signals = currentRun.signals[0]?.signals ?? [];

  const images = writeFixtureImages("synthetic", c.id, {
    baseline: baselineShot,
    current: currentShot,
    diff: diff?.diff,
  });

  return {
    id: c.id,
    label: c.label,
    source: "synthetic",
    viewport: viewport.label,
    diffPct: diff?.pct ?? 0,
    signals: toFixtureSignals(signals),
    images,
    notes: c.notes,
  };
}

async function main(): Promise<void> {
  const server = await startSeedServer();
  try {
    const entries: ManifestFixture[] = [];
    for (const c of SEED_CASES) {
      process.stdout.write(`  capturing ${c.id} (${c.label})… `);
      const entry = await captureCase(server.origin, c);
      process.stdout.write(`diff ${(entry.diffPct * 100).toFixed(3)}%\n`);
      entries.push(entry);
    }
    const manifest = upsertBySource("synthetic", entries);
    const curated = manifest.fixtures.filter((f) => f.source === "curated").length;
    console.log(`\nwrote ${entries.length} synthetic fixtures → ${FIXTURES_ROOT}`);
    console.log(`manifest: ${manifest.fixtures.length} fixtures total (${curated} curated preserved)`);
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error("eval:generate FAILED —", err);
  process.exit(1);
});
