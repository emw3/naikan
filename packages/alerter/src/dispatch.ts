/**
 * `dispatch` — the single public entry point of the alerter (issue #10). Fans one
 * `Alert` out to the routed channels (email if recipients, Slack if a webhook),
 * rendering each via the templates. Per-channel best-effort: a transport failure
 * marks that channel `failed` and is recorded in the result, never thrown — one
 * channel being down must not block the other or fail the caller's job (the
 * incident itself is already persisted; alerts are a side effect).
 */
import { renderEmail, renderSlack } from "./templates.ts";
import type {
  Alert,
  AlertChannels,
  AlertRouting,
  ChannelOutcome,
  DispatchResult,
} from "./types.ts";

export async function dispatch(
  alert: Alert,
  routing: AlertRouting,
  channels: AlertChannels,
): Promise<DispatchResult> {
  const [email, slack] = await Promise.all([
    sendEmail(alert, routing, channels),
    sendSlack(alert, routing, channels),
  ]);
  return { email, slack };
}

async function sendEmail(
  alert: Alert,
  routing: AlertRouting,
  channels: AlertChannels,
): Promise<ChannelOutcome> {
  if (routing.alertEmails.length === 0) return "skipped";
  try {
    await channels.sendEmail(routing.alertEmails, renderEmail(alert));
    return "sent";
  } catch {
    return "failed";
  }
}

async function sendSlack(
  alert: Alert,
  routing: AlertRouting,
  channels: AlertChannels,
): Promise<ChannelOutcome> {
  if (!routing.slackWebhookUrl) return "skipped";
  try {
    await channels.postSlack(routing.slackWebhookUrl, renderSlack(alert));
    return "sent";
  } catch {
    return "failed";
  }
}
