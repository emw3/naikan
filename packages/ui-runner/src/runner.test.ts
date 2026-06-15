import { expect, test } from "bun:test";
import { PNG } from "pngjs";
import type { Box, BrowserDriver, BrowserSession, CapturePage, ResolvedCaptureOptions, Size } from "@naikan/capture";
import { runUI } from "./runner.ts";
import type { Baseline, UIRunConfig } from "./types.ts";

/** Default clean observations for a captured page: 200, no console errors, within budget. */
function cleanObs(selectors: string[] = []): Omit<CapturePage, "screenshot" | "masks"> {
  const selectorsPresent: Record<string, boolean> = {};
  for (const s of selectors) selectorsPresent[s] = true;
  return {
    nav: { ok: true, status: 200 },
    console: [],
    perf: { lcpMs: 800, weightBytes: 1000, requestCount: 4 },
    selectorsPresent,
  };
}

/**
 * Fake driver — no Chromium. Records the sizes + opts it was asked to capture
 * and returns a deterministic buffer per size (with clean observations and no
 * masks), so unit tests can assert the viewport→size mapping, aggregation shape,
 * signal judgment, and option pass-through. `overrides(size, opts)` can swap in a
 * specific observation set per viewport.
 */
function fakeDriver(overrides?: (size: Size, opts: ResolvedCaptureOptions) => Partial<CapturePage>) {
  const seen: Array<{ url: string; size: Size; opts: ResolvedCaptureOptions }> = [];
  const driver: BrowserDriver = {
    async launch(): Promise<BrowserSession> {
      return {
        async capturePage(url, size, opts): Promise<CapturePage> {
          seen.push({ url, size, opts });
          return {
            screenshot: Buffer.from(`shot:${size.label}`),
            masks: [],
            ...cleanObs(opts.selectors),
            ...overrides?.(size, opts),
          };
        },
        async close(): Promise<void> {},
      };
    },
  };
  return { driver, seen };
}

/** A solid-white opaque PNG, optionally painting `box` black — for real-pixel diffing. */
function png(width: number, height: number, box?: Box): Buffer {
  const p = new PNG({ width, height });
  for (let i = 0; i < width * height * 4; i += 4) {
    p.data[i] = p.data[i + 1] = p.data[i + 2] = 255;
    p.data[i + 3] = 255;
  }
  if (box) {
    for (let y = box.y; y < box.y + box.height; y++) {
      for (let x = box.x; x < box.x + box.width; x++) {
        const i = (y * width + x) * 4;
        p.data[i] = p.data[i + 1] = p.data[i + 2] = 0;
        p.data[i + 3] = 255;
      }
    }
  }
  return PNG.sync.write(p);
}

/** Driver returning a caller-supplied PNG per viewport (clean obs, masks empty) — for diff tests. */
function pngDriver(shots: Record<string, Buffer>): BrowserDriver {
  return {
    async launch(): Promise<BrowserSession> {
      return {
        async capturePage(_url, size): Promise<CapturePage> {
          return { screenshot: shots[size.label]!, masks: [], ...cleanObs() };
        },
        async close(): Promise<void> {},
      };
    },
  };
}

const CONFIG: UIRunConfig = {
  url: "https://site.test/pricing",
  viewports: [
    { label: "mobile", width: 375, height: 812 },
    { label: "tablet", width: 768, height: 1024 },
    { label: "desktop", width: 1440, height: 900 },
  ],
};

test("returns one screenshot artifact per viewport, keyed and sized by viewport", async () => {
  const { driver } = fakeDriver();
  const { artifacts } = await runUI(CONFIG, undefined, { driver });
  expect(artifacts).toEqual([
    { viewport: "mobile", screenshot: Buffer.from("shot:mobile"), dims: { w: 375, h: 812 } },
    { viewport: "tablet", screenshot: Buffer.from("shot:tablet"), dims: { w: 768, h: 1024 } },
    { viewport: "desktop", screenshot: Buffer.from("shot:desktop"), dims: { w: 1440, h: 900 } },
  ]);
});

test("maps each viewport to a capture size against the config url, preserving order", async () => {
  const { driver, seen } = fakeDriver();
  await runUI(CONFIG, undefined, { driver });
  expect(seen.map((s) => s.size)).toEqual([
    { label: "mobile", width: 375, height: 812 },
    { label: "tablet", width: 768, height: 1024 },
    { label: "desktop", width: 1440, height: 900 },
  ]);
  expect(seen.every((s) => s.url === "https://site.test/pricing")).toBe(true);
});

// ---- signals (#13) ----

test("judges the four signals per viewport, in order", async () => {
  const { driver } = fakeDriver();
  const { signals } = await runUI(CONFIG, undefined, { driver });
  expect(signals.map((v) => v.viewport)).toEqual(["mobile", "tablet", "desktop"]);
  for (const v of signals) {
    expect(v.signals.map((s) => s.kind)).toEqual(["load", "console", "selector", "perf"]);
  }
});

test("a clean capture passes every signal at every viewport", async () => {
  const { driver } = fakeDriver();
  const { signals } = await runUI(CONFIG, undefined, { driver });
  expect(signals.every((v) => v.signals.every((s) => s.pass))).toBe(true);
});

test("a console error fails the console signal for the affected viewport", async () => {
  const { driver } = fakeDriver((size) =>
    size.label === "mobile" ? { console: [{ type: "error", text: "ReferenceError: x is not defined" }] } : {},
  );
  const { signals } = await runUI(CONFIG, undefined, { driver });
  const mobileConsole = signals.find((v) => v.viewport === "mobile")!.signals.find((s) => s.kind === "console")!;
  const desktopConsole = signals.find((v) => v.viewport === "desktop")!.signals.find((s) => s.kind === "console")!;
  expect(mobileConsole.pass).toBe(false);
  expect(mobileConsole.detail).toContain("ReferenceError: x is not defined");
  expect(desktopConsole.pass).toBe(true);
});

test("passes the check's required selectors through to capture and judges their presence", async () => {
  // capture reports #hero present, .missing absent.
  const { driver, seen } = fakeDriver(() => ({ selectorsPresent: { "#hero": true, ".missing": false } }));
  const { signals } = await runUI({ ...CONFIG, selectors: ["#hero", ".missing"] }, undefined, { driver });
  expect(seen.every((s) => JSON.stringify(s.opts.selectors) === JSON.stringify(["#hero", ".missing"]))).toBe(true);
  const sel = signals[0]!.signals.find((s) => s.kind === "selector")!;
  expect(sel.pass).toBe(false);
  expect(sel.detail).toContain(".missing");
});

test("judges the perf signal against the check's perf budget", async () => {
  const { driver } = fakeDriver(() => ({ perf: { lcpMs: 4000, weightBytes: 1000, requestCount: 4 } }));
  const { signals } = await runUI(
    { ...CONFIG, perfBudget: { lcpMs: 2500, pageWeightBytes: 3 * 1024 * 1024, maxRequests: 100 } },
    undefined,
    { driver },
  );
  const perf = signals[0]!.signals.find((s) => s.kind === "perf")!;
  expect(perf.pass).toBe(false);
  expect(perf.detail).toContain("LCP");
});

test("applies per-signal severities (load critical, others warning) by default", async () => {
  const { driver } = fakeDriver();
  const { signals } = await runUI(CONFIG, undefined, { driver });
  const byKind = Object.fromEntries(signals[0]!.signals.map((s) => [s.kind, s.severity]));
  expect(byKind).toEqual({ load: "critical", console: "warning", selector: "warning", perf: "warning" });
});

test("overrides per-signal severities from the config", async () => {
  const { driver } = fakeDriver();
  const { signals } = await runUI({ ...CONFIG, severities: { console: "critical" } }, undefined, { driver });
  const consoleSig = signals[0]!.signals.find((s) => s.kind === "console")!;
  expect(consoleSig.severity).toBe("critical");
});

test("passes captureOptions (settle, nav timeout) through to capture", async () => {
  const { driver, seen } = fakeDriver();
  await runUI(CONFIG, undefined, {
    driver,
    captureOptions: { settleMs: 25, navigationTimeoutMs: 4_000 },
  });
  expect(seen.every((s) => s.opts.settleMs === 25 && s.opts.navigationTimeoutMs === 4_000)).toBe(true);
});

test("applies capture's determinism defaults when no captureOptions given", async () => {
  const { driver, seen } = fakeDriver();
  await runUI(CONFIG, undefined, { driver });
  expect(seen[0]!.opts).toEqual({ settleMs: 500, navigationTimeoutMs: 30_000, maskSelectors: [], selectors: [] });
});

test("returns empty artifacts and signals for a config with no viewports", async () => {
  const { driver } = fakeDriver();
  const { artifacts, signals } = await runUI({ url: "https://x.test", viewports: [] }, undefined, { driver });
  expect(artifacts).toEqual([]);
  expect(signals).toEqual([]);
});

// ---- diffing against a baseline (#12) ----

test("returns no diffs when no baseline is supplied", async () => {
  const { driver } = fakeDriver();
  const { diffs } = await runUI(CONFIG, undefined, { driver });
  expect(diffs).toEqual([]);
});

test("diffs each viewport against its baseline, flagging only those over the threshold", async () => {
  // desktop changed by a 10x10 block over 20x20 (0.25); mobile unchanged.
  const current = { mobile: png(20, 20), desktop: png(20, 20, { x: 0, y: 0, width: 10, height: 10 }) };
  const baseline: Baseline = { screenshots: { mobile: png(20, 20), desktop: png(20, 20) } };
  const config: UIRunConfig = {
    url: "https://site.test/x",
    viewports: [
      { label: "mobile", width: 20, height: 20 },
      { label: "desktop", width: 20, height: 20 },
    ],
    diffThreshold: 0.1,
  };

  const { diffs } = await runUI(config, baseline, { driver: pngDriver(current) });

  const mobile = diffs.find((d) => d.viewport === "mobile")!;
  const desktop = diffs.find((d) => d.viewport === "desktop")!;
  expect(mobile.pct).toBe(0);
  expect(mobile.regressed).toBe(false);
  expect(desktop.pct).toBeCloseTo(0.25, 5);
  expect(desktop.regressed).toBe(true);
  expect(desktop.diff).toBeInstanceOf(Buffer);
});

test("skips viewports the baseline has no screenshot for", async () => {
  const current = { mobile: png(20, 20), desktop: png(20, 20) };
  const baseline: Baseline = { screenshots: { mobile: png(20, 20) } }; // no desktop baseline yet
  const config: UIRunConfig = {
    url: "https://site.test/x",
    viewports: [
      { label: "mobile", width: 20, height: 20 },
      { label: "desktop", width: 20, height: 20 },
    ],
  };

  const { diffs } = await runUI(config, baseline, { driver: pngDriver(current) });
  expect(diffs.map((d) => d.viewport)).toEqual(["mobile"]);
});

test("a dimension mismatch against the baseline is flagged regressed", async () => {
  const current = { desktop: png(20, 30) }; // taller than baseline → layout shifted
  const baseline: Baseline = { screenshots: { desktop: png(20, 20) } };
  const config: UIRunConfig = {
    url: "https://site.test/x",
    viewports: [{ label: "desktop", width: 20, height: 20 }],
    diffThreshold: 0.5,
  };

  const { diffs } = await runUI(config, baseline, { driver: pngDriver(current) });
  expect(diffs[0]!.dimensionMismatch).toBe(true);
  expect(diffs[0]!.regressed).toBe(true);
});

test("passes the check's ignoreRegions through to capture as maskSelectors", async () => {
  const { driver, seen } = fakeDriver();
  await runUI({ ...CONFIG, ignoreRegions: [".cookie-banner", "#chat"] }, undefined, { driver });
  expect(seen.every((s) => JSON.stringify(s.opts.maskSelectors) === JSON.stringify([".cookie-banner", "#chat"]))).toBe(
    true,
  );
});
