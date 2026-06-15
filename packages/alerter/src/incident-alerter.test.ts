import { expect, test } from "bun:test";
import { makeIncidentAlerter } from "./incident-alerter.ts";
import type { AlertChannels, EmailMessage, IncidentAlertEvent } from "./types.ts";

function recorder() {
  const emails: { to: string[]; message: EmailMessage }[] = [];
  const slacks: { webhookUrl: string; text: string }[] = [];
  const channels: AlertChannels = {
    sendEmail: (to, message) => (emails.push({ to, message }), Promise.resolve()),
    postSlack: (webhookUrl, text) => (slacks.push({ webhookUrl, text }), Promise.resolve()),
  };
  return { emails, slacks, channels };
}

const openedEvent: IncidentAlertEvent = {
  kind: "opened",
  projectId: "c1",
  projectName: "Acme",
  routing: { alertEmails: ["ops@acme.test"], slackWebhookUrl: "https://hooks.slack.test/x" },
  checkLabel: "acme.test/health",
  error: "HTTP 500",
  openedAt: new Date("2026-06-02T10:00:00Z"),
  closedAt: null,
  durationMs: null,
};

test("builds the per-project dashboard deep-link and dispatches to both channels", async () => {
  const { emails, slacks, channels } = recorder();
  const alerter = makeIncidentAlerter(channels, "https://monitor.test");
  await alerter(openedEvent);
  expect(emails[0]!.message.text).toContain("https://monitor.test/#/projects/c1");
  expect(slacks[0]!.text).toContain("https://monitor.test/#/projects/c1");
  expect(emails[0]!.message.subject).toBe("Incident opened for Acme / acme.test/health");
});

test("never throws even if a channel fails", async () => {
  const channels: AlertChannels = {
    sendEmail: () => Promise.reject(new Error("down")),
    postSlack: () => Promise.reject(new Error("down")),
  };
  const alerter = makeIncidentAlerter(channels, "https://monitor.test");
  await expect(alerter(openedEvent)).resolves.toBeUndefined();
});

test("maps a recovered event to a recovered alert with duration", async () => {
  const { emails, channels } = recorder();
  const alerter = makeIncidentAlerter(channels, "https://monitor.test");
  await alerter({
    ...openedEvent,
    kind: "recovered",
    error: null,
    closedAt: new Date("2026-06-02T10:30:00Z"),
    durationMs: 30 * 60_000,
  });
  expect(emails[0]!.message.subject).toContain("recovered");
  expect(emails[0]!.message.text).toContain("30m");
});

test("trims a trailing slash from the base URL when building the deep-link", async () => {
  const { emails, channels } = recorder();
  const alerter = makeIncidentAlerter(channels, "https://monitor.test/");
  await alerter(openedEvent);
  expect(emails[0]!.message.text).toContain("https://monitor.test/#/projects/c1");
});
