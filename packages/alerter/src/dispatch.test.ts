import { expect, test } from "bun:test";
import { dispatch } from "./dispatch.ts";
import type { Alert, AlertChannels, AlertRouting, EmailMessage } from "./types.ts";

const alert: Alert = {
  kind: "opened",
  projectName: "Acme",
  checkLabel: "acme.test/health",
  error: "HTTP 500",
  openedAt: new Date("2026-06-02T10:00:00Z"),
  dashboardUrl: "https://monitor.test/#/projects/c1",
};

/** A recording fake for both channels. */
function recorder() {
  const emails: { to: string[]; message: EmailMessage }[] = [];
  const slacks: { webhookUrl: string; text: string }[] = [];
  const channels: AlertChannels = {
    sendEmail: (to, message) => {
      emails.push({ to, message });
      return Promise.resolve();
    },
    postSlack: (webhookUrl, text) => {
      slacks.push({ webhookUrl, text });
      return Promise.resolve();
    },
  };
  return { emails, slacks, channels };
}

test("dispatch sends to both channels when both are routed", async () => {
  const { emails, slacks, channels } = recorder();
  const routing: AlertRouting = {
    alertEmails: ["ops@acme.test"],
    slackWebhookUrl: "https://hooks.slack.test/abc",
  };
  const result = await dispatch(alert, routing, channels);
  expect(result).toEqual({ email: "sent", slack: "sent" });
  expect(emails).toHaveLength(1);
  expect(emails[0]!.to).toEqual(["ops@acme.test"]);
  expect(emails[0]!.message.subject).toContain("opened for Acme");
  expect(slacks).toHaveLength(1);
  expect(slacks[0]!.webhookUrl).toBe("https://hooks.slack.test/abc");
});

test("dispatch skips email with no recipients and slack with no webhook", async () => {
  const { emails, slacks, channels } = recorder();
  const result = await dispatch(alert, { alertEmails: [], slackWebhookUrl: null }, channels);
  expect(result).toEqual({ email: "skipped", slack: "skipped" });
  expect(emails).toHaveLength(0);
  expect(slacks).toHaveLength(0);
});

test("dispatch marks a channel failed without throwing or blocking the other", async () => {
  const slacks: string[] = [];
  const channels: AlertChannels = {
    sendEmail: () => Promise.reject(new Error("resend down")),
    postSlack: (_url, text) => {
      slacks.push(text);
      return Promise.resolve();
    },
  };
  const routing: AlertRouting = {
    alertEmails: ["ops@acme.test"],
    slackWebhookUrl: "https://hooks.slack.test/abc",
  };
  const result = await dispatch(alert, routing, channels);
  expect(result).toEqual({ email: "failed", slack: "sent" });
  expect(slacks).toHaveLength(1);
});
