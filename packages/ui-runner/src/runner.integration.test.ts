/**
 * Real-Chromium integration test (issues #11a + #13 acceptance).
 *
 * Serves two local fixtures and runs `runUI` with NO injected driver, so the live
 * `@naikan/capture` Playwright driver launches a real headless Chromium:
 *
 * - `/clean`  — has both required selectors, no console errors → every signal passes.
 * - `/broken` — throws an uncaught ReferenceError + a console.error and is missing
 *               one required selector → the console and selector signals fail, while
 *               load (HTTP 200) and perf (generous budget) still pass.
 *
 * This is the one test that exercises the live browser path (screenshots + raw
 * observations → judged signals); everything else uses the fake driver.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { runUI } from "./runner.ts";
import type { PerfBudget, UIRunConfig } from "./types.ts";

const CLEAN_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>clean</title></head>
  <body>
    <header><h1 id="heading">Pricing</h1></header>
    <main><button class="cta">Buy</button><div style="height:1200px"></div></main>
  </body>
</html>`;

// Intentional breakage: a console.error plus an uncaught ReferenceError, and the
// `.cta` element is absent so a required selector is missing.
const BROKEN_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>broken</title></head>
  <body>
    <header><h1 id="heading">Pricing</h1></header>
    <main><div style="height:1200px"></div></main>
    <script>
      console.error("synthetic console error for the test");
      notDefinedFunction();
    </script>
  </body>
</html>`;

let server: ReturnType<typeof Bun.serve>;
let origin: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const body = new URL(req.url).pathname === "/broken" ? BROKEN_HTML : CLEAN_HTML;
      return new Response(body, { headers: { "content-type": "text/html" } });
    },
  });
  origin = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

/** PRD default viewport set: mobile / tablet / desktop. */
const VIEWPORTS = [
  { label: "mobile", width: 375, height: 812 },
  { label: "tablet", width: 768, height: 1024 },
  { label: "desktop", width: 1440, height: 900 },
];

/** Generous so the perf signal never fails on a local fixture — perf is exercised in unit tests. */
const LOOSE_BUDGET: PerfBudget = { lcpMs: 60_000, pageWeightBytes: 100 * 1024 * 1024, maxRequests: 1000 };

function isPng(buf: Buffer): boolean {
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

function sig(viewportSignals: { signals: { kind: string; pass: boolean; detail: string }[] }, kind: string) {
  return viewportSignals.signals.find((s) => s.kind === kind)!;
}

test(
  "captures a full-page PNG screenshot for all three viewports against a live Chromium",
  async () => {
    const config: UIRunConfig = {
      url: `${origin}/clean`,
      viewports: VIEWPORTS,
      selectors: ["#heading", ".cta"],
      perfBudget: LOOSE_BUDGET,
    };
    const { artifacts } = await runUI(config, undefined, { captureOptions: { settleMs: 100 } });

    expect(artifacts.map((a) => a.viewport)).toEqual(["mobile", "tablet", "desktop"]);
    for (const a of artifacts) {
      expect(isPng(a.screenshot)).toBe(true);
      expect(a.screenshot.length).toBeGreaterThan(0);
    }
    expect(artifacts.map((a) => a.dims)).toEqual([
      { w: 375, h: 812 },
      { w: 768, h: 1024 },
      { w: 1440, h: 900 },
    ]);
  },
  60_000,
);

test(
  "a clean page passes every signal at every viewport",
  async () => {
    const config: UIRunConfig = {
      url: `${origin}/clean`,
      viewports: VIEWPORTS,
      selectors: ["#heading", ".cta"],
      perfBudget: LOOSE_BUDGET,
    };
    const { signals } = await runUI(config, undefined, { captureOptions: { settleMs: 100 } });

    expect(signals.map((v) => v.viewport)).toEqual(["mobile", "tablet", "desktop"]);
    for (const v of signals) {
      expect(v.signals.map((s) => s.kind)).toEqual(["load", "console", "selector", "perf"]);
      expect(v.signals.every((s) => s.pass)).toBe(true);
    }
  },
  60_000,
);

test(
  "a console error + missing selector fail their signals; load and perf still pass",
  async () => {
    const config: UIRunConfig = {
      url: `${origin}/broken`,
      viewports: VIEWPORTS,
      selectors: ["#heading", ".cta"], // .cta is absent on /broken
      perfBudget: LOOSE_BUDGET,
    };
    const { signals } = await runUI(config, undefined, { captureOptions: { settleMs: 100 } });

    for (const v of signals) {
      expect(sig(v, "load").pass).toBe(true); // HTTP 200 even though the page's JS broke
      expect(sig(v, "perf").pass).toBe(true);
      expect(sig(v, "console").pass).toBe(false);
      const selector = sig(v, "selector");
      expect(selector.pass).toBe(false);
      expect(selector.detail).toContain(".cta");
      expect(selector.detail).not.toContain("#heading");
    }
  },
  60_000,
);
