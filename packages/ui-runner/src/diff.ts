/**
 * Masked pixel-diff of two full-page screenshots (issue #12).
 *
 * Pure and side-effect-free: decode two PNG buffers, paint the `ignore_regions`
 * mask boxes onto *both* before comparing (so a masked region can never count as
 * a difference), run pixelmatch, and report the differing-pixel fraction plus a
 * diff overlay PNG. `ui-runner` owns this judgment; `capture` only supplies the
 * raw mask geometry (ADR-0006).
 *
 * Screenshots are full-page, so height tracks content. If the two images differ
 * in size the layout height shifted — we fail the viewport outright rather than
 * pad-and-compare into a misleadingly-low diff % (issue #12).
 */
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type { Box } from "@naikan/capture";

/** Per-pixel colour-distance threshold handed to pixelmatch (its documented default). */
const PIXEL_THRESHOLD = 0.1;

export interface DiffOutcome {
  /** Differing-pixel fraction, 0..1. `1` when dimensions mismatched (fully failed). */
  pct: number;
  /** True when the two screenshots differed in size; no pixelmatch was run. */
  dimensionMismatch: boolean;
  /** Diff overlay PNG. Absent on a dimension mismatch (nothing meaningful to overlay). */
  diff?: Buffer;
}

/**
 * Diff `current` against `baseline`, masking `masks` on both images first.
 * Returns `{ pct: 1, dimensionMismatch: true }` (no overlay) when sizes differ.
 */
export function diffScreenshots(baseline: Buffer, current: Buffer, masks: Box[]): DiffOutcome {
  const base = PNG.sync.read(baseline);
  const curr = PNG.sync.read(current);

  if (base.width !== curr.width || base.height !== curr.height) {
    return { pct: 1, dimensionMismatch: true };
  }

  const { width, height } = base;
  paintMasks(base.data, width, height, masks);
  paintMasks(curr.data, width, height, masks);

  const overlay = new PNG({ width, height });
  const mismatched = pixelmatch(base.data, curr.data, overlay.data, width, height, {
    threshold: PIXEL_THRESHOLD,
  });

  return {
    pct: mismatched / (width * height),
    dimensionMismatch: false,
    diff: PNG.sync.write(overlay),
  };
}

/** Fill each mask box with solid opaque black, clamped to the image bounds. */
function paintMasks(data: Buffer, width: number, height: number, masks: Box[]): void {
  for (const m of masks) {
    const x0 = Math.max(0, Math.floor(m.x));
    const y0 = Math.max(0, Math.floor(m.y));
    const x1 = Math.min(width, Math.ceil(m.x + m.width));
    const y1 = Math.min(height, Math.ceil(m.y + m.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 255;
      }
    }
  }
}
