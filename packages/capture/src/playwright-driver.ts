/**
 * Live `BrowserDriver` backed by Playwright/Chromium — the default for
 * `capture()`. Node-only (carries the real `playwright` dependency) and
 * import-fenced to `apps/worker` per ADR-0006.
 *
 * `playwright` is imported lazily inside `launch()` so merely importing this
 * module (e.g. re-exported from the package index) stays cheap and the fake-
 * driver test path never pulls Playwright in.
 *
 * Determinism contract applied per page (issue #11a): one isolated context per
 * size sized to the viewport, `prefers-reduced-motion` forced, CSS
 * animations/transitions disabled from document start, wait for `load` +
 * `document.fonts.ready` + a settle delay, hard navigation timeout, and a
 * **full-page** screenshot.
 *
 * Raw observations (issue #13) are gathered in the same page session at near-zero
 * extra cost: console + uncaught-error messages via page listeners, navigation
 * transport/status from the `goto` response, and LCP / page weight / request
 * count + required-selector presence via in-page evaluation. All judgment-free —
 * `@naikan/ui-runner` turns these into Signals.
 */
import type {
  Box,
  BrowserDriver,
  BrowserSession,
  CapturePage,
  ConsoleMessage,
  PerfObservation,
} from "./types.ts";

/** Injected at document start so load-time animations never run. */
const DETERMINISM_CSS =
  "*,*::before,*::after{animation:none!important;transition:none!important;" +
  "animation-duration:0s!important;transition-duration:0s!important;" +
  "caret-color:transparent!important;scroll-behavior:auto!important}";

// The browser-side snippets below run inside Chromium, not in this runtime, so
// they are passed as strings rather than typed functions. That keeps this
// package — and everything that depends on it — free of a DOM `lib` requirement
// (no `document`/`performance`/`window` reference is type-checked here),
// preserving the clean kernel seam from ADR-0006.
// Runs at document_start, where `document.head`/`document.documentElement` may
// not be parsed yet — so append once a target exists rather than dereferencing
// null (which would surface as a console/pageerror and pollute the console
// signal, #13). A MutationObserver retries until the element appears.
const INJECT_DETERMINISM_CSS = `(() => {
  const css = ${JSON.stringify(DETERMINISM_CSS)};
  const inject = () => {
    const target = document.head || document.documentElement;
    if (!target) return false;
    const style = document.createElement("style");
    style.textContent = css;
    target.appendChild(style);
    return true;
  };
  if (!inject()) {
    const obs = new MutationObserver(() => { if (inject()) obs.disconnect(); });
    obs.observe(document, { childList: true, subtree: true });
  }
})();`;

// Start observing Largest Contentful Paint before navigation so the metric is
// captured. Stashed on a global the post-settle read picks up. Buffered so
// entries that fired before the observer attached are still delivered.
const INJECT_PERF_OBSERVER = `(() => {
  window.__naikanLcp = 0;
  try {
    const obs = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) window.__naikanLcp = last.startTime;
    });
    obs.observe({ type: "largest-contentful-paint", buffered: true });
  } catch (e) {
    /* unsupported — leave LCP at 0 (reported as null) */
  }
})();`;

// Read raw perf after the page has settled: total transferred bytes (navigation
// + resources) and request count from Resource Timing, plus the LCP the observer
// recorded. No budget comparison here — that is ui-runner's job.
const READ_PERF = `(() => {
  const resources = performance.getEntriesByType("resource");
  const navEntry = performance.getEntriesByType("navigation")[0];
  let weightBytes = navEntry ? (navEntry.transferSize || 0) : 0;
  for (const r of resources) weightBytes += r.transferSize || 0;
  const lcp = window.__naikanLcp || 0;
  return { lcpMs: lcp > 0 ? lcp : null, weightBytes, requestCount: resources.length + (navEntry ? 1 : 0) };
})();`;

/**
 * Build a browser-side expression (string, per the seam comment above) that
 * resolves each selector's matched elements to full-page-pixel boxes. Coordinates
 * are made document-absolute (`+ scrollX/scrollY`) so they line up with the
 * full-page screenshot regardless of scroll position. Zero-area boxes are
 * dropped. The selectors are embedded as a JSON literal so no argument needs to
 * cross the string-expression boundary.
 */
function boxesExpression(maskSelectors: string[]): string {
  return `(() => {
  const sels = ${JSON.stringify(maskSelectors)};
  const boxes = [];
  for (const sel of sels) {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingProjectRect();
      if (r.width > 0 && r.height > 0) {
        boxes.push({ x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height });
      }
    }
  }
  return boxes;
})();`;
}

/**
 * Build a browser-side expression reporting, per requested selector, whether it
 * resolved to at least one element. Presence only — ui-runner decides "all
 * required must be present". Selectors are embedded as a JSON literal.
 */
function selectorsPresentExpression(selectors: string[]): string {
  return `(() => {
  const sels = ${JSON.stringify(selectors)};
  const out = {};
  for (const sel of sels) out[sel] = document.querySelectorAll(sel).length > 0;
  return out;
})();`;
}

export function livePlaywrightDriver(): BrowserDriver {
  return {
    async launch(): Promise<BrowserSession> {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true });

      return {
        async capturePage(url, size, opts): Promise<CapturePage> {
          const context = await browser.newContext({
            viewport: { width: size.width, height: size.height },
            reducedMotion: "reduce",
          });
          try {
            // Kill animations/transitions and start the LCP observer from the
            // first paint, before navigation.
            await context.addInitScript({ content: INJECT_DETERMINISM_CSS });
            await context.addInitScript({ content: INJECT_PERF_OBSERVER });

            const page = await context.newPage();

            // Collect console output + uncaught page errors for the whole session.
            // An uncaught exception (e.g. a ReferenceError) is recorded as an
            // `error` line so the console signal catches it (#13).
            const consoleMessages: ConsoleMessage[] = [];
            page.on("console", (m) => consoleMessages.push({ type: m.type(), text: m.text() }));
            page.on("pageerror", (e) => consoleMessages.push({ type: "error", text: e.message }));

            // Navigation is recorded as raw fact: a transport failure (DNS,
            // connection, timeout) yields nav.ok=false rather than throwing, so
            // the load signal can judge it. A 4xx/5xx still resolves with a
            // response — capture reports the status, ui-runner judges 2xx.
            let nav: { ok: boolean; status: number | null };
            try {
              const response = await page.goto(url, { waitUntil: "load", timeout: opts.navigationTimeoutMs });
              nav = { ok: true, status: response ? response.status() : null };
              // Wait for web fonts to finish so text is painted, not swapped mid-shot.
              await page.evaluate("document.fonts.ready");
              await page.waitForTimeout(opts.settleMs);
            } catch {
              nav = { ok: false, status: null };
            }

            // Resolve geometry + observations before the shot, while the page is
            // still settled at scroll 0. All best-effort: an error page still
            // evaluates (empty timing) and screenshots, so a failed nav never
            // turns into a thrown capture.
            const masks =
              opts.maskSelectors.length > 0
                ? ((await page.evaluate(boxesExpression(opts.maskSelectors))) as Box[])
                : [];
            const selectorsPresent =
              opts.selectors.length > 0
                ? ((await page.evaluate(selectorsPresentExpression(opts.selectors))) as Record<string, boolean>)
                : {};
            const perf = (await page.evaluate(READ_PERF)) as PerfObservation;
            const screenshot = await page.screenshot({ fullPage: true });

            return { screenshot, masks, nav, console: consoleMessages, perf, selectorsPresent };
          } finally {
            await context.close();
          }
        },

        async close(): Promise<void> {
          await browser.close();
        },
      };
    },
  };
}
