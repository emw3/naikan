/**
 * Curated real-case capturer (issue #05). Captures a real before/after URL pair
 * through the same `@naikan/ui-runner` pipeline the platform runs, writes a
 * candidate fixture under `fixtures/curated/<id>/`, and records it `source:
 * curated` with the label YOU assign — the one human-in-the-loop step in the
 * dataset (a human picks the URLs + confirms the label after eyeballing the diff).
 *
 * Node-only (drives Playwright; needs network egress to the target sites). Usage:
 *
 *   node packages/eval-dataset/src/curate.ts <id> <label> <baselineUrl> <currentUrl> [notes...]
 *   # or:  bun run eval:curate <id> <label> <baselineUrl> <currentUrl> [notes...]
 *
 * label ∈ real_regression | noise | intentional. For a NOISE case, pass the same
 * live URL twice — two captures seconds apart differ from content churn. For an
 * intentional redesign or a regression, point at two snapshots (e.g. two Wayback
 * Machine timestamps of the same page) that bracket the change.
 *
 * Real before/after pairs usually differ in page height, so the diff is a
 * dimension mismatch (diffPct = 1, no overlay) — that is an honest pipeline
 * outcome the judge sees, recorded faithfully. Same-height pairs get a real
 * overlay.
 */
import { runUI, resolveViewports, type Baseline } from "@naikan/ui-runner";
import { LABELS, type Label } from "./types.ts";
import { toFixtureSignals, upsertBySource, writeFixtureImages, readManifest, FIXTURES_ROOT } from "./corpus.ts";
import type { ManifestFixture } from "./types.ts";

const VIEWPORT = "desktop";

function parseArgs(argv: string[]): { id: string; label: Label; baselineUrl: string; currentUrl: string; notes?: string } {
  const [id, label, baselineUrl, currentUrl, ...notes] = argv;
  if (!id || !label || !baselineUrl || !currentUrl) {
    throw new Error(
      "usage: eval:curate <id> <label> <baselineUrl> <currentUrl> [notes...]\n" +
        `  label ∈ ${LABELS.filter((l) => l !== "uncertain").join(" | ")}`,
    );
  }
  if (!LABELS.includes(label as Label) || label === "uncertain") {
    throw new Error(`bad label "${label}" — expected ${LABELS.filter((l) => l !== "uncertain").join(" | ")}`);
  }
  return { id, label: label as Label, baselineUrl, currentUrl, notes: notes.length ? notes.join(" ") : undefined };
}

async function main(): Promise<void> {
  const { id, label, baselineUrl, currentUrl, notes } = parseArgs(process.argv.slice(2));
  const [viewport] = resolveViewports([VIEWPORT]);

  console.log(`curating "${id}" (${label})`);
  console.log(`  baseline: ${baselineUrl}`);
  console.log(`  current:  ${currentUrl}`);

  const baselineRun = await runUI({ url: baselineUrl, viewports: [viewport], diffThreshold: 0 });
  const baselineShot = baselineRun.artifacts[0].screenshot;

  const baseline: Baseline = { screenshots: { [viewport.label]: baselineShot } };
  const currentRun = await runUI({ url: currentUrl, viewports: [viewport], diffThreshold: 0 }, baseline);
  const currentShot = currentRun.artifacts[0].screenshot;
  const diff = currentRun.diffs[0];

  const images = writeFixtureImages("curated", id, {
    baseline: baselineShot,
    current: currentShot,
    diff: diff?.diff,
  });

  const entry: ManifestFixture = {
    id,
    label,
    source: "curated",
    viewport: viewport.label,
    diffPct: diff?.pct ?? 0,
    signals: toFixtureSignals(currentRun.signals[0]?.signals ?? []),
    images,
    notes: notes ?? `human-confirmed ${label}`,
    sourceUrls: { baseline: baselineUrl, current: currentUrl },
  };

  // Preserve synthetic + other curated entries; upsert this one by id.
  const existing = readManifest().fixtures.filter((f) => f.source === "curated" && f.id !== id);
  upsertBySource("curated", [...existing, entry]);

  const pct = (entry.diffPct * 100).toFixed(3);
  const dim = diff && diff.dimensionMismatch ? " (dimension mismatch — no overlay)" : "";
  console.log(`\nwrote curated/${id}/ — diff ${pct}%${dim}`);
  console.log(`Eyeball fixtures/curated/${id}/{baseline,current,diff}.png and confirm the label is "${label}".`);
  console.log(`Corpus root: ${FIXTURES_ROOT}`);
}

main().catch((err) => {
  console.error("eval:curate FAILED —", err);
  process.exit(1);
});
