/**
 * On-disk corpus helpers (issue #05) — write fixture images + maintain the
 * manifest. Used by `generate.ts` (synthetic) and `curate.ts` (curated). Both
 * upsert *their own source* and leave the other source's entries untouched, so
 * re-running the generator never clobbers the human-curated cases and vice versa.
 *
 * Node-only (fs); never imported by the loadable package surface.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { DatasetManifest, FixtureSignal, FixtureSource, ManifestFixture } from "./types.ts";

/** The shipped corpus root (`packages/eval-dataset/fixtures`). */
export const FIXTURES_ROOT = fileURLToPath(new URL("../fixtures", import.meta.url));

/** Current manifest schema version. */
export const MANIFEST_VERSION = 1;

/** The three images one fixture carries (diff absent on a dimension mismatch). */
export interface FixtureImages {
  baseline: Buffer;
  current: Buffer;
  diff?: Buffer;
}

/** Read the manifest at `root`, or an empty one if none exists yet. */
export function readManifest(root: string = FIXTURES_ROOT): DatasetManifest {
  const path = resolve(root, "manifest.json");
  if (!existsSync(path)) return { version: MANIFEST_VERSION, fixtures: [] };
  return JSON.parse(readFileSync(path, "utf8")) as DatasetManifest;
}

/** Write `manifest.json` pretty-printed (stable, diff-friendly). */
export function writeManifest(manifest: DatasetManifest, root: string = FIXTURES_ROOT): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(resolve(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

/**
 * Write a fixture's images under `<source>/<id>/` and return the manifest-relative
 * image references.
 */
export function writeFixtureImages(
  source: FixtureSource,
  id: string,
  images: FixtureImages,
  root: string = FIXTURES_ROOT,
): ManifestFixture["images"] {
  const dir = resolve(root, source, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "baseline.png"), images.baseline);
  writeFileSync(resolve(dir, "current.png"), images.current);
  const refs: ManifestFixture["images"] = {
    baseline: `${source}/${id}/baseline.png`,
    current: `${source}/${id}/current.png`,
  };
  if (images.diff) {
    writeFileSync(resolve(dir, "diff.png"), images.diff);
    refs.diff = `${source}/${id}/diff.png`;
  }
  return refs;
}

/**
 * Replace every manifest entry of `source` with `entries`, preserving the other
 * source's entries, and write the manifest back. Sorted synthetic-then-curated by
 * id so the committed file is stable across regenerations.
 */
export function upsertBySource(
  source: FixtureSource,
  entries: ManifestFixture[],
  root: string = FIXTURES_ROOT,
): DatasetManifest {
  const existing = readManifest(root);
  const kept = existing.fixtures.filter((f) => f.source !== source);
  const order: Record<FixtureSource, number> = { synthetic: 0, curated: 1 };
  const fixtures = [...kept, ...entries].sort(
    (a, b) => order[a.source] - order[b.source] || a.id.localeCompare(b.id),
  );
  const manifest: DatasetManifest = { version: MANIFEST_VERSION, fixtures };
  writeManifest(manifest, root);
  return manifest;
}

/** Map `@naikan/ui-runner` Signals (typed unions) to the plain fixture shape. */
export function toFixtureSignals(
  signals: { kind: string; pass: boolean; severity: string; detail: string }[],
): FixtureSignal[] {
  return signals.map((s) => ({ kind: s.kind, pass: s.pass, severity: s.severity, detail: s.detail }));
}
