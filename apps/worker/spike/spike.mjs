// Playwright/Bun-vs-Node worker-runtime spike harness (issue #02 / ADR-0001).
//
// Identical file is executed under BOTH `bun run spike.mjs` and `node spike.mjs`
// so the only variable between runs is the JS runtime driving Playwright.
//
// Per iteration: launch a FRESH Chromium, navigate to a local file:// fixture,
// screenshot, capture console messages + Navigation Timing, close the browser.
// Fresh-launch-per-iteration is deliberate: it measures cold-start time and
// stresses the native bindings / browser-pipe 50x (the historical Bun pain point).
//
// Each iteration is bounded by a hard WATCHDOG. Playwright's own op timeouts are
// 30s; the watchdog (40s) is the backstop for the worse failure mode where the
// driver<->Chromium pipe wedges and even Playwright's timers stop firing. On a
// watchdog trip the browser process is SIGKILLed and the iteration is recorded
// as a failure so the run always completes all 50 iterations on both runtimes.
//
// Emits a single JSON line prefixed `__SPIKE_RESULT__` on stdout for the
// orchestrator to parse. Everything else goes to stderr.

import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ITERATIONS = Number(process.env.SPIKE_ITERATIONS ?? 50);
const WATCHDOG_MS = Number(process.env.SPIKE_WATCHDOG_MS ?? 40000);

const runtime =
  typeof globalThis.Bun !== "undefined"
    ? { name: "bun", version: globalThis.Bun.version }
    : { name: "node", version: process.version.replace(/^v/, "") };

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureUrl = pathToFileURL(join(__dirname, "fixture.html")).href;

const log = (...a) => process.stderr.write(a.join(" ") + "\n");
const firstLine = (err) =>
  String(err && err.stack ? err.stack.split("\n")[0] : err);

// Sample driver-process RSS continuously; the browser runs in its own process,
// so the driver RSS is the runtime-comparison signal we care about.
let peakRssBytes = process.memoryUsage().rss;
const rssTimer = setInterval(() => {
  const rss = process.memoryUsage().rss;
  if (rss > peakRssBytes) peakRssBytes = rss;
}, 50);
if (typeof rssTimer.unref === "function") rssTimer.unref();

const iterations = [];

// Belt-and-suspenders: after a wedged iteration, reap any orphaned Chromium.
// Execution is strictly sequential so at most one browser is ever live.
function sweepStrayBrowsers() {
  try {
    execSync("pkill -9 -f 'headless_shell|chrome-headless' 2>/dev/null", {
      stdio: "ignore",
    });
  } catch {
    /* pkill exits non-zero when nothing matched — fine */
  }
}

async function hardCloseBrowser(browser) {
  if (!browser) return;
  const proc = browser.process && browser.process();
  const killTimer = setTimeout(() => {
    try {
      proc && proc.kill && proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, 5000);
  if (typeof killTimer.unref === "function") killTimer.unref();
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise((r) => setTimeout(r, 6000)),
  ]);
  clearTimeout(killTimer);
}

async function runOnce(i) {
  const t0 = performance.now();
  const consoleMsgs = [];
  let browser;
  let watchdog;
  let timedOut = false;

  try {
    const work = (async () => {
      browser = await chromium.launch({ headless: true, timeout: 30000 });
      const tLaunched = performance.now();
      const page = await browser.newPage();
      page.on("console", (m) => consoleMsgs.push(m.type()));
      await page.goto(fixtureUrl, { waitUntil: "load", timeout: 30000 });
      await page.waitForSelector("#heading", { timeout: 30000 });
      const shot = await page.screenshot();
      const nav = await page.evaluate(() => {
        const e = performance.getEntriesByType("navigation")[0];
        return e
          ? { domContentLoaded: e.domContentLoadedEventEnd, load: e.loadEventEnd }
          : null;
      });
      return { tLaunched, shot, nav };
    })();

    const watchdogP = new Promise((_, reject) => {
      watchdog = setTimeout(() => {
        timedOut = true;
        reject(
          new Error(`WATCHDOG: iteration exceeded ${WATCHDOG_MS}ms (wedged)`),
        );
      }, WATCHDOG_MS);
      if (typeof watchdog.unref === "function") watchdog.unref();
    });

    const r = await Promise.race([work, watchdogP]);
    const tDone = performance.now();
    iterations.push({
      i,
      ok: true,
      launchMs: +(r.tLaunched - t0).toFixed(1),
      totalMs: +(tDone - t0).toFixed(1),
      screenshotBytes: r.shot.length,
      consoleCount: consoleMsgs.length,
      nav: r.nav,
    });
  } catch (err) {
    iterations.push({
      i,
      ok: false,
      totalMs: +(performance.now() - t0).toFixed(1),
      error: firstLine(err),
    });
    log(`  iter ${i}: FAIL ${firstLine(err)}`);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    await hardCloseBrowser(browser);
    if (timedOut) sweepStrayBrowsers();
  }
}

log(`[${runtime.name} ${runtime.version}] starting ${ITERATIONS} iterations`);
const wallStart = performance.now();
for (let i = 1; i <= ITERATIONS; i++) {
  await runOnce(i);
  if (i % 10 === 0) log(`  ...${i}/${ITERATIONS}`);
}
const wallMs = performance.now() - wallStart;
clearInterval(rssTimer);

const ok = iterations.filter((r) => r.ok);
const failed = iterations.filter((r) => !r.ok);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const summary = {
  runtime,
  iterations: ITERATIONS,
  successCount: ok.length,
  failureCount: failed.length,
  peakRssMB: +(peakRssBytes / 1024 / 1024).toFixed(1),
  avgRunMs: +avg(ok.map((r) => r.totalMs)).toFixed(1),
  avgLaunchMs: +avg(ok.map((r) => r.launchMs)).toFixed(1),
  totalWallSec: +(wallMs / 1000).toFixed(1),
  consoleCountSample: ok[0]?.consoleCount ?? null,
  screenshotBytesSample: ok[0]?.screenshotBytes ?? null,
  failures: failed.map((r) => ({ i: r.i, error: r.error })).slice(0, 20),
};

log(`[${runtime.name}] done: ${JSON.stringify(summary)}`);
process.stdout.write("__SPIKE_RESULT__" + JSON.stringify(summary) + "\n");
