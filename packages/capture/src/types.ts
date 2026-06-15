/**
 * Types for `@naikan/capture` — the site-agnostic Playwright session.
 *
 * `capture()` launches one browser, opens one isolated context per requested
 * size, and returns full-page screenshot pixels plus raw observations per size as
 * **plain data**: no Playwright type ever crosses this seam (ADR-0006). It makes
 * no pass/fail judgment — that is `@naikan/ui-runner`'s job (#13).
 *
 * The browser is reached only through the injectable `BrowserDriver`, so the
 * orchestration (one launch, one context per size, always close) is unit-
 * testable against a fake driver without launching Chromium. The default driver
 * is the live Playwright one.
 */

/** A viewport to capture at. */
export interface Size {
  /** Stable label used as the artifact/viewport key, e.g. `desktop`. */
  label: string;
  width: number;
  height: number;
}

/**
 * A full-page-pixel-space rectangle, in CSS pixels at deviceScaleFactor 1 (so
 * one box unit equals one screenshot pixel). Raw geometry only — `capture` makes
 * no judgment about what a box *means*; `ui-runner` decides these are ignore
 * regions and paints them before diffing (ADR-0006).
 */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Navigation outcome of the main document, as raw fact (#13). `ok` is the
 * transport result — did the browser get a response at all (no DNS/connection/
 * timeout error). `status` is the final HTTP status, or null when the transport
 * failed (no response) — `capture` does not decide whether a status is "good".
 */
export interface NavObservation {
  ok: boolean;
  status: number | null;
}

/** One captured console line (or uncaught page error, recorded as type `error`). */
export interface ConsoleMessage {
  /** Console level: `error`, `warning`, `log`, … (uncaught exceptions → `error`). */
  type: string;
  text: string;
}

/**
 * Raw performance observations for the page session (#13), collected via a
 * PerformanceObserver + resource timing. No budget judgment here — `ui-runner`
 * compares these to `perf_budget`.
 */
export interface PerfObservation {
  /** Largest Contentful Paint, ms — null when none was reported. */
  lcpMs: number | null;
  /** Total transferred bytes across the navigation + resource responses. */
  weightBytes: number;
  /** Number of requests (navigation + resources). */
  requestCount: number;
}

/**
 * Plain-data result of one `capturePage` call: a screenshot plus the raw
 * observations gathered in the same page session. No Playwright object is
 * exposed. `masks` carries the bounding boxes of the requested `maskSelectors`;
 * `selectorsPresent` reports, per requested `selectors` entry, whether it
 * resolved to ≥1 element (presence only — `ui-runner` decides "all required").
 */
export interface CapturePage {
  screenshot: Buffer;
  masks: Box[];
  nav: NavObservation;
  console: ConsoleMessage[];
  perf: PerfObservation;
  selectorsPresent: Record<string, boolean>;
}

/**
 * Plain-data result of capturing one size — a `CapturePage` plus the viewport
 * `label` and dims. `screenshot` is a PNG buffer; no Playwright object is
 * exposed. All observations are judgment-free; `ui-runner` turns them into
 * Signals (#13).
 */
export interface CaptureResult extends CapturePage {
  label: string;
  dims: { w: number; h: number };
}

/** Tuning + dependency injection for a `capture()` run. All optional. */
export interface CaptureOptions {
  /** Settle delay after `load` + `document.fonts.ready`, in ms. Default 500. */
  settleMs?: number;
  /** Hard navigation timeout, in ms. Default 30000. */
  navigationTimeoutMs?: number;
  /**
   * CSS selectors whose matched elements' bounding boxes are returned as `masks`
   * (raw geometry — no painting, no judgment). Default none.
   */
  maskSelectors?: string[];
  /**
   * CSS selectors whose presence is reported in `selectorsPresent` (presence
   * only — no judgment). Default none. (#13)
   */
  selectors?: string[];
  /** Browser seam. Defaults to the live Playwright driver. */
  driver?: BrowserDriver;
}

/** `CaptureOptions` with every tuning knob resolved to a concrete value. */
export interface ResolvedCaptureOptions {
  settleMs: number;
  navigationTimeoutMs: number;
  maskSelectors: string[];
  selectors: string[];
}

/**
 * One launched browser. `capture()` opens one isolated context per size against
 * it via `capturePage`, then `close()`s it exactly once.
 */
export interface BrowserSession {
  /**
   * Open a fresh isolated context sized to `size`, navigate to `url`, apply the
   * determinism contract, and return a full-page PNG screenshot, the bounding
   * boxes of `opts.maskSelectors`, and the raw observations (nav/console/perf/
   * selector presence) gathered in the same session. The live driver owns the
   * determinism work (disable animations/transitions, force
   * `prefers-reduced-motion`, wait `load` + fonts + settle, hard nav timeout).
   */
  capturePage(url: string, size: Size, opts: ResolvedCaptureOptions): Promise<CapturePage>;
  /** Tear the browser down. Called once per `capture()` run, even on error. */
  close(): Promise<void>;
}

/**
 * Abstracts the browser so the capture orchestration is testable without
 * Chromium. The single seam shared by `capture` and `ui-runner`'s unit tests.
 */
export interface BrowserDriver {
  /** Launch one browser. `capture()` calls this exactly once per run. */
  launch(): Promise<BrowserSession>;
}
