/** Public surface of `@naikan/alerter` (issue #10). */
export type {
  Alert,
  AlertCheckType,
  AlertChannels,
  AlertRouting,
  ChannelOutcome,
  DispatchResult,
  EmailMessage,
  EmailSender,
  IncidentAlertEvent,
  SlackPoster,
} from "./types.ts";
export { dispatch } from "./dispatch.ts";
export { renderEmail, renderSlack, formatDuration } from "./templates.ts";
export { renderDigestEmail, renderDigestSlack } from "./digest-templates.ts";
export { createLiveChannels } from "./channels.ts";
export { makeIncidentAlerter } from "./incident-alerter.ts";
