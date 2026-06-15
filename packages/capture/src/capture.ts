/**
 * `@naikan/capture` — site-agnostic Playwright session.
 *
 * One browser launch per call; one isolated context per size; one full-page
 * screenshot per size. Returns only plain data (`CaptureResult[]`) and makes no
 * pass/fail judgment — the seam to `@naikan/ui-runner` (ADR-0006).
 *
 * The browser is reached through an injectable `BrowserDriver`. When none is
 * given, the live Playwright driver is loaded lazily, so injecting a fake driver
 * exercises this orchestration without pulling Playwright in at all.
 */
import type { BrowserDriver, CaptureOptions, CaptureResult, ResolvedCaptureOptions, Size } from "./types.ts";

/** Settle delay after `load` + `document.fonts.ready`. */
const DEFAULT_SETTLE_MS = 500;
/** Hard navigation timeout. */
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;

export async function capture(
  url: string,
  sizes: Size[],
  opts: CaptureOptions = {},
): Promise<CaptureResult[]> {
  const driver = opts.driver ?? (await liveDriver());
  const pageOpts: ResolvedCaptureOptions = {
    settleMs: opts.settleMs ?? DEFAULT_SETTLE_MS,
    navigationTimeoutMs: opts.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
    maskSelectors: opts.maskSelectors ?? [],
    selectors: opts.selectors ?? [],
  };

  const session = await driver.launch();
  try {
    const results: CaptureResult[] = [];
    // Sequential: one isolated context per size against the single browser.
    for (const size of sizes) {
      const page = await session.capturePage(url, size, pageOpts);
      results.push({ ...page, label: size.label, dims: { w: size.width, h: size.height } });
    }
    return results;
  } finally {
    await session.close();
  }
}

/** Lazily load the live Playwright driver so the fake-driver path stays Playwright-free. */
async function liveDriver(): Promise<BrowserDriver> {
  const { livePlaywrightDriver } = await import("./playwright-driver.ts");
  return livePlaywrightDriver();
}
