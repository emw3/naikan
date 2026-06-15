/** Public surface of `@naikan/capture`. */
export type {
  Box,
  BrowserDriver,
  BrowserSession,
  CapturePage,
  CaptureOptions,
  CaptureResult,
  ConsoleMessage,
  NavObservation,
  PerfObservation,
  ResolvedCaptureOptions,
  Size,
} from "./types.ts";
export { capture } from "./capture.ts";
export { livePlaywrightDriver } from "./playwright-driver.ts";
