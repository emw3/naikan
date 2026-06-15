import { expect, test } from "bun:test";
import { renderEmail, renderSlack } from "./templates.ts";
import type { Alert } from "./types.ts";

const opened: Alert = {
  kind: "opened",
  projectName: "Acme",
  checkLabel: "acme.test/health",
  error: "HTTP 500",
  openedAt: new Date("2026-06-02T10:00:00Z"),
  dashboardUrl: "https://monitor.test/#/projects/c1",
};

const recovered: Alert = {
  kind: "recovered",
  projectName: "Acme",
  checkLabel: "acme.test/health",
  openedAt: new Date("2026-06-02T10:00:00Z"),
  closedAt: new Date("2026-06-02T10:30:00Z"),
  durationMs: 30 * 60_000,
  dashboardUrl: "https://monitor.test/#/projects/c1",
};

test("opened email names project + check and carries the error and deep-link", () => {
  const msg = renderEmail(opened);
  expect(msg.subject).toBe("Incident opened for Acme / acme.test/health");
  expect(msg.text).toContain("HTTP 500");
  expect(msg.text).toContain("https://monitor.test/#/projects/c1");
});

test("recovered email reports the downtime duration and deep-link", () => {
  const msg = renderEmail(recovered);
  expect(msg.subject).toBe("Incident recovered for Acme / acme.test/health");
  expect(msg.text).toContain("30m");
  expect(msg.text).toContain("https://monitor.test/#/projects/c1");
});

test("slack text mirrors the email subject line", () => {
  expect(renderSlack(opened)).toContain("Incident opened for Acme / acme.test/health");
  expect(renderSlack(recovered)).toContain("recovered");
  expect(renderSlack(recovered)).toContain("30m");
});

// ---- UI-check copy (#14): per-check-type subject + body ----

const uiOpened: Alert = {
  kind: "opened",
  checkType: "uicheck",
  projectName: "Acme",
  checkLabel: "acme.test/pricing",
  error: "load: HTTP 500",
  openedAt: new Date("2026-06-02T10:00:00Z"),
  dashboardUrl: "https://monitor.test/#/projects/c1",
};

const uiRecovered: Alert = {
  kind: "recovered",
  checkType: "uicheck",
  projectName: "Acme",
  checkLabel: "acme.test/pricing",
  openedAt: new Date("2026-06-02T10:00:00Z"),
  closedAt: new Date("2026-06-04T10:00:00Z"),
  durationMs: 48 * 60 * 60_000,
  dashboardUrl: "https://monitor.test/#/projects/c1",
};

test("uicheck opened reads as a UI-check failure, not an incident", () => {
  const msg = renderEmail(uiOpened);
  expect(msg.subject).toBe("UI check failed for Acme / acme.test/pricing");
  expect(msg.text).toContain("UI check failed at");
  expect(msg.text).toContain("load: HTTP 500");
  expect(renderSlack(uiOpened)).toContain("UI check failed for Acme / acme.test/pricing");
});

test("uicheck recovered reports the (multi-day) downtime", () => {
  const msg = renderEmail(uiRecovered);
  expect(msg.subject).toBe("UI check recovered for Acme / acme.test/pricing");
  expect(msg.text).toContain("48h");
});

test("an absent checkType still renders heartbeat wording (back-compat)", () => {
  expect(renderEmail(opened).subject).toBe("Incident opened for Acme / acme.test/health");
});
