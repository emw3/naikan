/**
 * Live channel adapters (issue #10, ADR-0003). Email via the Resend HTTP API,
 * Slack via an incoming-webhook POST. `fetch` is injectable so the adapters are
 * unit-testable without real network. These are the only place that touches an
 * external service — everything above (`dispatch`, templates) is pure.
 */
import type { AlertChannels, EmailMessage } from "./types.ts";

/** Minimal `fetch` shape we depend on (global in Bun + Node ≥ 18). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface LiveChannelsConfig {
  /** Resend API key (`RESEND_API_KEY`). */
  resendApiKey: string;
  /** Verified sender, e.g. `alerts@example.com` (`ALERT_FROM_EMAIL`). */
  fromEmail: string;
  /** Override for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Build the live email + Slack adapters from config. */
export function createLiveChannels(config: LiveChannelsConfig): AlertChannels {
  const doFetch: FetchLike = config.fetchImpl ?? ((url, init) => fetch(url, init));

  const sendEmail = async (to: string[], message: EmailMessage): Promise<void> => {
    const res = await doFetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.resendApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: config.fromEmail,
        to,
        subject: message.subject,
        text: message.text,
      }),
    });
    if (!res.ok) {
      throw new Error(`Resend send failed: ${res.status} ${await safeText(res)}`);
    }
  };

  const postSlack = async (webhookUrl: string, text: string): Promise<void> => {
    const res = await doFetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      throw new Error(`Slack webhook failed: ${res.status} ${await safeText(res)}`);
    }
  };

  return { sendEmail, postSlack };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
