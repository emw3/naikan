import { expect, test } from "bun:test";
import { PNG } from "pngjs";
import type { Box } from "@naikan/capture";
import { diffScreenshots } from "./diff.ts";

/** A solid-white opaque PNG buffer, optionally painted by `paint` before encoding. */
function png(width: number, height: number, paint?: (data: Buffer, w: number) => void): Buffer {
  const p = new PNG({ width, height });
  for (let i = 0; i < width * height * 4; i += 4) {
    p.data[i] = 255;
    p.data[i + 1] = 255;
    p.data[i + 2] = 255;
    p.data[i + 3] = 255;
  }
  paint?.(p.data, width);
  return PNG.sync.write(p);
}

/** Paint `box` solid black into RGBA `data` of row stride `w`. */
function blackRect(box: Box): (data: Buffer, w: number) => void {
  return (data, w) => {
    for (let y = box.y; y < box.y + box.height; y++) {
      for (let x = box.x; x < box.x + box.width; x++) {
        const i = (y * w + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 255;
      }
    }
  };
}

test("identical screenshots diff to 0% and produce an overlay", () => {
  const out = diffScreenshots(png(20, 20), png(20, 20), []);
  expect(out.dimensionMismatch).toBe(false);
  expect(out.pct).toBe(0);
  expect(out.diff).toBeInstanceOf(Buffer);
});

test("a changed region yields a diff fraction matching the changed area", () => {
  // 10x10 black block over a 20x20 white image = 100 of 400 px = 0.25.
  const base = png(20, 20);
  const changed = png(20, 20, blackRect({ x: 0, y: 0, width: 10, height: 10 }));
  const out = diffScreenshots(base, changed, []);
  expect(out.dimensionMismatch).toBe(false);
  expect(out.pct).toBeCloseTo(0.25, 5);
});

test("masking the changed region drops the diff back to 0%", () => {
  const base = png(20, 20);
  const changed = png(20, 20, blackRect({ x: 0, y: 0, width: 10, height: 10 }));
  const out = diffScreenshots(base, changed, [{ x: 0, y: 0, width: 10, height: 10 }]);
  expect(out.pct).toBe(0);
});

test("dimension mismatch fails the viewport without running pixelmatch", () => {
  // Full-page height shifted: do not pad-and-compare, just fail (issue #12).
  const out = diffScreenshots(png(20, 20), png(20, 30), []);
  expect(out.dimensionMismatch).toBe(true);
  expect(out.pct).toBe(1);
  expect(out.diff).toBeUndefined();
});
