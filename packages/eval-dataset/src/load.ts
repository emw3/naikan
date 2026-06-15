/**
 * `loadDataset` — read the labeled golden corpus off disk (issue #05).
 *
 * Reads `<root>/manifest.json`, validates each entry against the label/source
 * vocabulary, resolves the relative image references to absolute paths, and
 * asserts every referenced image exists — so a corrupt or half-generated corpus
 * fails loudly here rather than deep inside the slice #06 harness.
 *
 * Pure given a directory (just `node:fs`/`node:path` + the manifest), so it is the
 * one unit-tested piece of this package; the generator/curator are integration
 * scripts that exercise the real capture pipeline and are not unit-tested.
 */
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { LABELS, type DatasetManifest, type Fixture, type ManifestFixture } from "./types.ts";

/** The committed corpus shipped with the package: `packages/eval-dataset/fixtures`. */
export const DEFAULT_DATASET_ROOT = fileURLToPath(new URL("../fixtures", import.meta.url));

const SOURCES = new Set(["synthetic", "curated"]);
const LABEL_SET = new Set<string>(LABELS);

/**
 * Load the labeled dataset from `root` (default: the shipped corpus). Returns one
 * `Fixture` per manifest entry with image references resolved to absolute paths.
 * Throws on a missing/invalid manifest, an unknown label/source, or a referenced
 * image that is absent on disk.
 */
export function loadDataset(root: string = DEFAULT_DATASET_ROOT): Fixture[] {
  const manifestPath = resolve(root, "manifest.json");
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    throw new Error(`eval-dataset: manifest not found at ${manifestPath}`);
  }

  let manifest: DatasetManifest;
  try {
    manifest = JSON.parse(raw) as DatasetManifest;
  } catch (err) {
    throw new Error(`eval-dataset: manifest is not valid JSON (${manifestPath}): ${String(err)}`);
  }
  if (!Array.isArray(manifest.fixtures)) {
    throw new Error(`eval-dataset: manifest has no "fixtures" array (${manifestPath})`);
  }

  return manifest.fixtures.map((f) => toFixture(f, root, manifestPath));
}

function toFixture(f: ManifestFixture, root: string, manifestPath: string): Fixture {
  const where = `fixture "${f.id ?? "<no id>"}" (${manifestPath})`;
  if (!f.id) throw new Error(`eval-dataset: ${where} — missing id`);
  if (!LABEL_SET.has(f.label)) {
    throw new Error(`eval-dataset: ${where} — unknown label "${f.label}" (expected one of ${LABELS.join(", ")})`);
  }
  if (!SOURCES.has(f.source)) {
    throw new Error(`eval-dataset: ${where} — unknown source "${f.source}" (expected synthetic | curated)`);
  }
  if (!f.images?.baseline || !f.images.current) {
    throw new Error(`eval-dataset: ${where} — images.baseline and images.current are required`);
  }

  const baselinePath = resolveImage(f.images.baseline, root, where);
  const currentPath = resolveImage(f.images.current, root, where);
  const diffPath = f.images.diff ? resolveImage(f.images.diff, root, where) : undefined;

  const { images: _images, ...rest } = f;
  return { ...rest, baselinePath, currentPath, diffPath };
}

/** Resolve a manifest-relative image ref to an absolute path and assert it exists. */
function resolveImage(ref: string, root: string, where: string): string {
  const abs = isAbsolute(ref) ? ref : resolve(root, ref);
  try {
    statSync(abs);
  } catch {
    throw new Error(`eval-dataset: ${where} — image not found: ${abs}`);
  }
  return abs;
}
