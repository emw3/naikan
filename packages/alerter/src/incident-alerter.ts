/**
 * `makeIncidentAlerter` — the glue between the incident orchestrator and the
 * channels. The orchestrator (config-repo) resolves an `IncidentAlertEvent` but
 * has no public base URL; this closes over `appBaseUrl` + the channels, builds
 * the dashboard deep-link, maps the event to an `Alert`, and dispatches. Returns
 * the bound callback the orchestrator accepts. Never throws — a failed alert must
 * not fail the CheckRun job (the incident is already persisted).
 */
import { dispatch } from "./dispatch.ts";
import type { Alert, AlertChannels, IncidentAlertEvent } from "./types.ts";

/** Build the incident-transition callback the orchestrator calls. */
export function makeIncidentAlerter(
  channels: AlertChannels,
  appBaseUrl: string,
): (event: IncidentAlertEvent) => Promise<void> {
  return async (event) => {
    try {
      const alert = toAlert(event, dashboardUrl(appBaseUrl, event.projectId));
      await dispatch(alert, event.routing, channels);
    } catch {
      // Best-effort: never let an alerting failure escape into the job.
    }
  };
}

/** `${base}/#/projects/:id` — the web-admin hash route for a project's incidents. */
function dashboardUrl(appBaseUrl: string, projectId: string): string {
  return `${appBaseUrl.replace(/\/+$/, "")}/#/projects/${projectId}`;
}

function toAlert(event: IncidentAlertEvent, url: string): Alert {
  if (event.kind === "opened") {
    return {
      kind: "opened",
      checkType: event.checkType,
      projectName: event.projectName,
      checkLabel: event.checkLabel,
      error: event.error,
      openedAt: event.openedAt,
      dashboardUrl: url,
    };
  }
  return {
    kind: "recovered",
    checkType: event.checkType,
    projectName: event.projectName,
    checkLabel: event.checkLabel,
    openedAt: event.openedAt,
    closedAt: event.closedAt ?? event.openedAt,
    durationMs: event.durationMs ?? 0,
    dashboardUrl: url,
  };
}
