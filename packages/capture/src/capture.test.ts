import { expect, test } from "bun:test";
import { capture } from "./capture.ts";
import type {
  Box,
  BrowserDriver,
  BrowserSession,
  CapturePage,
  ResolvedCaptureOptions,
  Size,
} from "./types.ts";

/**
 * A fake driver that launches no browser. It records every call so tests can
 * assert the orchestration (one launch, one page per size, always close), returns
 * a deterministic buffer derived from the size label, surfaces one mask box per
 * requested `maskSelector`, and reports a fixed set of judgment-free observations
 * (nav/console/perf) plus presence for each requested `selectors` entry — so tests
 * can assert the raw observations flow back out on `CaptureResult`.
 */
function fakeDriver() {
  const calls = {
    launches: 0,
    closes: 0,
    pages: [] as Array<{ url: string; size: Size; opts: ResolvedCaptureOptions }>,
  };
  const driver: BrowserDriver = {
    async launch(): Promise<BrowserSession> {
      calls.launches++;
      return {
        async capturePage(url, size, opts): Promise<CapturePage> {
          calls.pages.push({ url, size, opts });
          const masks: Box[] = opts.maskSelectors.map((_sel, i) => ({
            x: i,
            y: i,
            width: 10,
            height: 10,
          }));
          const selectorsPresent: Record<string, boolean> = {};
          for (const sel of opts.selectors) selectorsPresent[sel] = true;
          return {
            screenshot: Buffer.from(`shot:${size.label}`),
            masks,
            nav: { ok: true, status: 200 },
            console: [{ type: "error", text: `boom:${size.label}` }],
            perf: { lcpMs: 1200, weightBytes: 4096, requestCount: 7 },
            selectorsPresent,
          };
        },
        async close(): Promise<void> {
          calls.closes++;
        },
      };
    },
  };
  return { driver, calls };
}

const SIZES: Size[] = [
  { label: "mobile", width: 375, height: 812 },
  { label: "tablet", width: 768, height: 1024 },
  { label: "desktop", width: 1440, height: 900 },
];

test("launches the browser exactly once per capture() call", async () => {
  const { driver, calls } = fakeDriver();
  await capture("https://x.test", SIZES, { driver });
  expect(calls.launches).toBe(1);
});

test("captures one page per size, in order, passing the size and url through", async () => {
  const { driver, calls } = fakeDriver();
  await capture("https://x.test/page", SIZES, { driver });
  expect(calls.pages.map((p) => p.size.label)).toEqual(["mobile", "tablet", "desktop"]);
  expect(calls.pages.every((p) => p.url === "https://x.test/page")).toBe(true);
});

test("returns one CaptureResult per size with label, screenshot, dims, (empty) masks, and observations", async () => {
  const { driver } = fakeDriver();
  const results = await capture("https://x.test", SIZES, { driver });
  expect(results).toEqual([
    {
      label: "mobile",
      screenshot: Buffer.from("shot:mobile"),
      dims: { w: 375, h: 812 },
      masks: [],
      nav: { ok: true, status: 200 },
      console: [{ type: "error", text: "boom:mobile" }],
      perf: { lcpMs: 1200, weightBytes: 4096, requestCount: 7 },
      selectorsPresent: {},
    },
    {
      label: "tablet",
      screenshot: Buffer.from("shot:tablet"),
      dims: { w: 768, h: 1024 },
      masks: [],
      nav: { ok: true, status: 200 },
      console: [{ type: "error", text: "boom:tablet" }],
      perf: { lcpMs: 1200, weightBytes: 4096, requestCount: 7 },
      selectorsPresent: {},
    },
    {
      label: "desktop",
      screenshot: Buffer.from("shot:desktop"),
      dims: { w: 1440, h: 900 },
      masks: [],
      nav: { ok: true, status: 200 },
      console: [{ type: "error", text: "boom:desktop" }],
      perf: { lcpMs: 1200, weightBytes: 4096, requestCount: 7 },
      selectorsPresent: {},
    },
  ]);
});

test("passes mask selectors through to the driver and surfaces the returned boxes per result", async () => {
  const { driver, calls } = fakeDriver();
  const results = await capture("https://x.test", [SIZES[0]!], {
    driver,
    maskSelectors: [".ad", "#banner"],
  });
  expect(calls.pages[0]!.opts.maskSelectors).toEqual([".ad", "#banner"]);
  expect(results[0]!.masks).toEqual([
    { x: 0, y: 0, width: 10, height: 10 },
    { x: 1, y: 1, width: 10, height: 10 },
  ]);
});

test("passes required selectors through to the driver and surfaces their presence per result", async () => {
  const { driver, calls } = fakeDriver();
  const results = await capture("https://x.test", [SIZES[0]!], {
    driver,
    selectors: ["#hero", ".cta"],
  });
  expect(calls.pages[0]!.opts.selectors).toEqual(["#hero", ".cta"]);
  expect(results[0]!.selectorsPresent).toEqual({ "#hero": true, ".cta": true });
});

test("applies determinism defaults (settle 500ms, nav timeout 30s, no masks, no selectors) when opts omitted", async () => {
  const { driver, calls } = fakeDriver();
  await capture("https://x.test", [SIZES[0]!], { driver });
  expect(calls.pages[0]!.opts).toEqual({
    settleMs: 500,
    navigationTimeoutMs: 30_000,
    maskSelectors: [],
    selectors: [],
  });
});

test("passes through overridden settle and navigation-timeout opts", async () => {
  const { driver, calls } = fakeDriver();
  await capture("https://x.test", [SIZES[0]!], { driver, settleMs: 50, navigationTimeoutMs: 5_000 });
  expect(calls.pages[0]!.opts).toEqual({
    settleMs: 50,
    navigationTimeoutMs: 5_000,
    maskSelectors: [],
    selectors: [],
  });
});

test("returns an empty result set for no sizes (still launches and closes)", async () => {
  const { driver, calls } = fakeDriver();
  const results = await capture("https://x.test", [], { driver });
  expect(results).toEqual([]);
  expect(calls.launches).toBe(1);
  expect(calls.closes).toBe(1);
});

test("closes the session exactly once on success", async () => {
  const { driver, calls } = fakeDriver();
  await capture("https://x.test", SIZES, { driver });
  expect(calls.closes).toBe(1);
});

test("closes the session even when a page capture throws, and propagates the error", async () => {
  let closed = 0;
  const driver: BrowserDriver = {
    async launch(): Promise<BrowserSession> {
      return {
        async capturePage(): Promise<CapturePage> {
          throw new Error("boom");
        },
        async close(): Promise<void> {
          closed++;
        },
      };
    },
  };
  await expect(capture("https://x.test", SIZES, { driver })).rejects.toThrow("boom");
  expect(closed).toBe(1);
});
