/**
 * Types for `@naikan/alerter` (issue #10) — the module that turns an incident
 * transition into per-project email + Slack messages. The single public entry
 * point is `dispatch(alert, routing, channels)`; the email/Slack adapters are
 * internal (ADR-0003: email via Resend, Slack via incoming webhook).
 *
 * No TS parameter properties / enums / namespaces here: this package is imported
 * by the Node strip-only worker (ADR-0001/0005), same constraint as the kernel.
 */

/**
 * Which kind of check an alert is about. Drives per-check-type copy (#14):
 * heartbeat alerts read as "Incident opened/recovered", UI alerts as "UI check
 * failed/recovered". Optional — absent is treated as `heartbeat` (the original
 * behaviour, so existing callers are unchanged).
 */
export type AlertCheckType = "heartbeat" | "uicheck";

/** An incident alert to deliver. `opened` carries the current error; `recovered` the downtime. */
export type Alert =
  | {
      kind: "opened";
      /** What kind of check this is about; absent → heartbeat. */
      checkType?: AlertCheckType;
      /** Project display name, e.g. "Acme". */
      projectName: string;
      /** Human label for the check, e.g. "acme.test/health". */
      checkLabel: string;
      /** The failing run's error summary (may be null). */
      error: string | null;
      /** When the failure that opened the incident began. */
      openedAt: Date;
      /** Absolute link to the project's dashboard view. */
      dashboardUrl: string;
    }
  | {
      kind: "recovered";
      /** What kind of check this is about; absent → heartbeat. */
      checkType?: AlertCheckType;
      projectName: string;
      checkLabel: string;
      openedAt: Date;
      /** When the incident closed (2 consecutive successes). */
      closedAt: Date;
      /** Total downtime, `closedAt - openedAt`, in milliseconds. */
      durationMs: number;
      dashboardUrl: string;
    };

/** Where one project's alerts go. Email may be empty; the webhook may be unset. */
export interface AlertRouting {
  /** Recipients for alert email. Empty → skip email. */
  alertEmails: string[];
  /** Slack incoming-webhook URL. Null → skip Slack. */
  slackWebhookUrl: string | null;
}

/** A rendered email, ready for the email channel. */
export interface EmailMessage {
  subject: string;
  /** Plain-text body (MVP — no HTML template yet). */
  text: string;
}

/** Sends one email to one or more recipients. Throws on transport failure. */
export type EmailSender = (to: string[], message: EmailMessage) => Promise<void>;

/** Posts one message to a Slack incoming-webhook URL. Throws on transport failure. */
export type SlackPoster = (webhookUrl: string, text: string) => Promise<void>;

/** The injectable channel adapters `dispatch` fans out to. */
export interface AlertChannels {
  sendEmail: EmailSender;
  postSlack: SlackPoster;
}

/** Per-channel outcome of a dispatch. */
export type ChannelOutcome = "sent" | "skipped" | "failed";

/** What `dispatch` did on each channel. */
export interface DispatchResult {
  email: ChannelOutcome;
  slack: ChannelOutcome;
}

/**
 * The resolved, DB-free description of an incident transition the orchestrator
 * hands to the injected alerter callback. The app maps this to an `Alert`
 * (adding the dashboard deep-link) before dispatching.
 */
export interface IncidentAlertEvent {
  kind: "opened" | "recovered";
  /** What kind of check this incident is for; absent → heartbeat (#14). */
  checkType?: AlertCheckType;
  projectId: string;
  projectName: string;
  routing: AlertRouting;
  checkLabel: string;
  /** Opening run's error (kind=opened); null otherwise. */
  error: string | null;
  openedAt: Date;
  /** Set only when kind=recovered. */
  closedAt: Date | null;
  /** Set only when kind=recovered. */
  durationMs: number | null;
}
