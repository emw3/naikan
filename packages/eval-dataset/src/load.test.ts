/**
 * Unit tests for `loadDataset` — the one pure unit of `@naikan/eval-dataset`
 * (issue #05). The generator/demo-seed are not unit-tested (they exercise the real
 * capture pipeline, per the PRD's testing decisions); the loader is, because it is
 * pure given a dataset directory: parse the manifest, validate, resolve paths.
 *
 * Each test builds a throwaway dataset dir under the OS temp dir, so no test
 * artifacts are committed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { loadDataset } from "./load.ts";
import type { DatasetManifest, ManifestFixture } from "./types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write a dataset dir (manifest + dummy image files for each referenced image). */
function writeDataset(manifest: DatasetManifest): string {
  const root = mkdtempSync(join(tmpdir(), "eval-dataset-"));
  dirs.push(root);
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  for (const f of manifest.fixtures) {
    for (const rel of Object.values(f.images)) {
      if (!rel) continue;
      const abs = join(root, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, "PNG");
    }
  }
  return root;
}

const baseFixture: ManifestFixture = {
  id: "layout-break",
  label: "real_regression",
  source: "synthetic",
  viewport: "desktop",
  diffPct: 0.12,
  signals: [{ kind: "load", pass: true, severity: "critical", detail: "200 OK" }],
  images: {
    baseline: "synthetic/layout-break/baseline.png",
    current: "synthetic/layout-break/current.png",
    diff: "synthetic/layout-break/diff.png",
  },
};

test("loads a fixture and resolves image paths to absolute", () => {
  const root = writeDataset({ version: 1, fixtures: [baseFixture] });
  const [fixture] = loadDataset(root);

  expect(fixture.id).toBe("layout-break");
  expect(fixture.label).toBe("real_regression");
  expect(fixture.source).toBe("synthetic");
  expect(fixture.diffPct).toBe(0.12);
  expect(fixture.signals).toEqual(baseFixture.signals);

  expect(isAbsolute(fixture.baselinePath)).toBe(true);
  expect(fixture.baselinePath).toBe(join(root, "synthetic/layout-break/baseline.png"));
  expect(fixture.currentPath).toBe(join(root, "synthetic/layout-break/current.png"));
  expect(fixture.diffPath).toBe(join(root, "synthetic/layout-break/diff.png"));
  // The flattened image references are gone — only the resolved paths remain.
  expect((fixture as unknown as { images?: unknown }).images).toBeUndefined();
});

test("diffPath is undefined when the manifest omits a diff (dimension mismatch)", () => {
  const root = writeDataset({
    version: 1,
    fixtures: [{ ...baseFixture, images: { baseline: "b.png", current: "c.png" } }],
  });
  const [fixture] = loadDataset(root);
  expect(fixture.diffPath).toBeUndefined();
  expect(fixture.baselinePath).toBe(join(root, "b.png"));
});

test("preserves curated provenance fields", () => {
  const root = writeDataset({
    version: 1,
    fixtures: [
      {
        ...baseFixture,
        id: "real-redesign",
        source: "curated",
        label: "intentional",
        notes: "human-confirmed: brand redesign",
        sourceUrls: { baseline: "https://web.archive.org/a", current: "https://web.archive.org/b" },
      },
    ],
  });
  const [fixture] = loadDataset(root);
  expect(fixture.source).toBe("curated");
  expect(fixture.notes).toBe("human-confirmed: brand redesign");
  expect(fixture.sourceUrls?.baseline).toBe("https://web.archive.org/a");
});

test("throws on an unknown label (corrupt corpus)", () => {
  const root = writeDataset({
    version: 1,
    // deliberately invalid label
    fixtures: [{ ...baseFixture, label: "totally-broken" as ManifestFixture["label"] }],
  });
  expect(() => loadDataset(root)).toThrow(/label/);
});

test("throws when a referenced image file is missing on disk", () => {
  const root = mkdtempSync(join(tmpdir(), "eval-dataset-"));
  dirs.push(root);
  // Manifest references images that were never written.
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ version: 1, fixtures: [baseFixture] }));
  expect(() => loadDataset(root)).toThrow(/baseline\.png|not found|missing/i);
});

test("throws a clear error when the manifest is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "eval-dataset-"));
  dirs.push(root);
  expect(() => loadDataset(root)).toThrow(/manifest/i);
});

describe("default root", () => {
  test("loads the committed corpus without an explicit root", () => {
    // The shipped corpus must always parse + every image must exist. This is the
    // guard that a corrupt/half-generated commit fails loudly.
    const fixtures = loadDataset();
    expect(fixtures.length).toBeGreaterThan(0);
    for (const f of fixtures) {
      expect(isAbsolute(f.baselinePath)).toBe(true);
    }
  });
});
