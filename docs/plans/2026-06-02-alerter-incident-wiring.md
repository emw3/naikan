# Alerter (email + Slack) wired to incidents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dispatch incident `opened` / `closed-recovered` transitions to per-project email (Resend) and Slack (incoming webhook), via a single `dispatch(alert, routing)` entry point with internal channel adapters (issue #10).

**Architecture:** A new leaf package `@naikan/alerter` owns channels + templates + `dispatch`; it knows nothing about the DB. The existing incident orchestrator (`config-repo/incident-orchestrator.ts`) already detects the single transition after each CheckRun — we extend it to *resolve* the business data (project routing, check label, error, duration) into an `IncidentAlertEvent` and hand it to an injected, best-effort `alerter` callback. The apps (worker job + API run-now) construct the live channels from env, build the deep-link, and wire the callback. Idempotency is structural: a transition is only produced once per real DB state change (an open incident yields `still-open` → no event), and dispatch failures are swallowed so a retried job never re-sends.

**Tech Stack:** TypeScript (Bun for tests/API, Node strip-only loader for the worker — **no TS parameter properties / enums / namespaces** in `@naikan/alerter` or `config-repo`, per ADR-0001/0005), `postgres` (raw SQL), `node-pg-migrate`, Resend HTTP API, Slack incoming webhooks, Svelte 5 (web-admin), `bun test`.

---

## File Structure

**New package `packages/alerter/`** (leaf — no `@naikan/*` runtime deps):
- `package.json` — `@naikan/alerter`, `type: module`, entry `src/index.ts`.
- `src/types.ts` — `Alert` (discriminated `opened|recovered`), `AlertRouting`, `EmailMessage`, `EmailSender`, `SlackPoster`, `AlertChannels`, `DispatchResult`, `IncidentAlertEvent`.
- `src/templates.ts` — `renderEmail(alert) → EmailMessage`, `renderSlack(alert) → string` (subject/body + dashboard deep-link).
- `src/dispatch.ts` — `dispatch(alert, routing, channels) → DispatchResult` (fan-out, per-channel best-effort).
- `src/channels.ts` — `createLiveChannels({ resendApiKey, fromEmail }) → AlertChannels` (Resend POST + Slack webhook POST).
- `src/incident-alerter.ts` — `makeIncidentAlerter(channels, appBaseUrl) → (event: IncidentAlertEvent) => Promise<void>` (event → `Alert` + deep-link → `dispatch`, never throws).
- `src/index.ts` — public exports.
- `src/templates.test.ts`, `src/dispatch.test.ts`, `src/incident-alerter.test.ts` — recording-fake smoke tests.

**Modified:**
- `migrations/1830000000000_project-slack-webhook.js` — **create**: add nullable `slack_webhook_url` to `projects`.
- `packages/config-repo/package.json` — add `@naikan/alerter` dep.
- `packages/config-repo/src/types.ts` — `Project` + `ProjectInput` gain `slackWebhookUrl`.
- `packages/config-repo/src/repo.ts` — validate/normalize `slackWebhookUrl`; add to `PROJECT_FIELDS`.
- `packages/config-repo/src/pg-store.ts` — `ProjectRow` + `toProject` + insert + `projectPatchRow`.
- `packages/config-repo/src/incident-orchestrator.ts` — accept optional `alerter`; resolve + emit `IncidentAlertEvent`.
- `apps/worker/package.json` — add `@naikan/alerter` dep.
- `apps/worker/src/job.ts` — thread `alerter` through to `applyIncidentForRun`.
- `apps/worker/src/index.ts` — build channels + `makeIncidentAlerter` from env; pass to job.
- `apps/api/src/heartbeat/routes.ts` — `HeartbeatAppOptions.alerter?`; run-now passes it through.
- `apps/api/src/index.ts` — build channels + alerter from env; pass to `createHeartbeatApp`.
- `apps/web-admin/src/lib/api.ts` — `Project` + `ProjectInput` gain `slackWebhookUrl`.
- `apps/web-admin/src/Projects.svelte` + `ProjectDetail.svelte` — webhook URL form field.
- `.env.example` — `RESEND_API_KEY`, `ALERT_FROM_EMAIL`, `APP_BASE_URL`.

**`config-repo` → `alerter` is a one-way, type-only import** (`IncidentAlertEvent`); the runtime callback is injected from the apps, so `config-repo` keeps zero runtime coupling to network code. `alerter` imports nothing from `config-repo`. Acyclic.

**Routing decision (MVP scope):** incidents route to the **Project's** `alertEmails` + `slackWebhookUrl`. The `CheckGroup.defaultAlertRouting` (a #08 forward-looking field whose `slackChannel` is a display name, not a webhook) is **out of scope** for #10 and noted as a follow-up. The existing `Project.slackChannel` (`#name`) stays a display label; the new `slackWebhookUrl` is the actual Slack send target.

---

## Task 1: Scaffold `@naikan/alerter` — types, templates, dispatch

**Files:**
- Create: `packages/alerter/package.json`
- Create: `packages/alerter/src/types.ts`
- Create: `packages/alerter/src/templates.ts`
- Create: `packages/alerter/src/dispatch.ts`
- Create: `packages/alerter/src/index.ts`
- Test: `packages/alerter/src/templates.test.ts`, `packages/alerter/src/dispatch.test.ts`

- [ ] **Step 1: Create the package manifest**

`packages/alerter/package.json`:
```json
{
  "name": "@naikan/alerter",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "module": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "bun test"
  },
  "devDependencies": {
    "@types/node": "^22.10.0"
  }
}
```

- [ ] **Step 2: Define the types** (`packages/alerter/src/types.ts`)

```ts
/**
 * Types for `@naikan/alerter` (issue #10) — the module that turns an incident
 * transition into per-project email + Slack messages. The single public entry
 * point is `dispatch(alert, routing, channels)`; the email/Slack adapters are
 * internal (ADR-0003: email via Resend, Slack via incoming webhook).
 *
 * No TS parameter properties / enums / namespaces here: this package is imported
 * by the Node strip-only worker (ADR-0001/0005), same constraint as the kernel.
 */

/** An incident alert to deliver. `opened` carries the current error; `recovered` the downtime. */
export type Alert =
  | {
      kind: "opened";
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
```

- [ ] **Step 3: Write the failing templates test** (`packages/alerter/src/templates.test.ts`)

```ts
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
```

- [ ] **Step 4: Run it, expect FAIL**

Run: `bun test packages/alerter/src/templates.test.ts`
Expected: FAIL — `Cannot find module './templates.ts'`.

- [ ] **Step 5: Implement templates** (`packages/alerter/src/templates.ts`)

```ts
/**
 * Alert message templates (issue #10). One subject + body per transition, with a
 * deep-link to the project's dashboard. Plain text for MVP — a richer HTML email
 * can slot in behind `renderEmail` later without touching `dispatch`.
 */
import type { Alert, EmailMessage } from "./types.ts";

/** Humanise a millisecond span as `Xm` or `Xh Ym` (mirrors the dashboard). */
export function formatDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Subject line shared by email + Slack. */
function subjectFor(alert: Alert): string {
  const verb = alert.kind === "opened" ? "opened" : "recovered";
  return `Incident ${verb} for ${alert.projectName} / ${alert.checkLabel}`;
}

/** Render the email subject + plain-text body for an alert. */
export function renderEmail(alert: Alert): EmailMessage {
  const subject = subjectFor(alert);
  const lines: string[] = [subject, ""];
  if (alert.kind === "opened") {
    lines.push(`Opened at ${alert.openedAt.toISOString()}.`);
    lines.push(`Error: ${alert.error ?? "(no detail)"}.`);
  } else {
    lines.push(`Recovered at ${alert.closedAt.toISOString()}.`);
    lines.push(`Down for ${formatDuration(alert.durationMs)} (opened ${alert.openedAt.toISOString()}).`);
  }
  lines.push("", `Dashboard: ${alert.dashboardUrl}`);
  return { subject, text: lines.join("\n") };
}

/** Render the Slack message text for an alert. */
export function renderSlack(alert: Alert): string {
  const head = subjectFor(alert);
  const detail =
    alert.kind === "opened"
      ? `Error: ${alert.error ?? "(no detail)"}`
      : `Down for ${formatDuration(alert.durationMs)}`;
  return `${head}\n${detail}\n${alert.dashboardUrl}`;
}
```

- [ ] **Step 6: Run templates test, expect PASS**

Run: `bun test packages/alerter/src/templates.test.ts` → Expected: PASS (3 tests).

- [ ] **Step 7: Write the failing dispatch test** (`packages/alerter/src/dispatch.test.ts`)

```ts
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
```

- [ ] **Step 8: Run it, expect FAIL**

Run: `bun test packages/alerter/src/dispatch.test.ts` → Expected: FAIL — `Cannot find module './dispatch.ts'`.

- [ ] **Step 9: Implement dispatch** (`packages/alerter/src/dispatch.ts`)

```ts
/**
 * `dispatch` — the single public entry point of the alerter (issue #10). Fans one
 * `Alert` out to the routed channels (email if recipients, Slack if a webhook),
 * rendering each via the templates. Per-channel best-effort: a transport failure
 * marks that channel `failed` and is recorded in the result, never thrown — one
 * channel being down must not block the other or fail the caller's job (the
 * incident itself is already persisted; alerts are a side effect).
 */
import { renderEmail, renderSlack } from "./templates.ts";
import type { Alert, AlertChannels, AlertRouting, ChannelOutcome, DispatchResult } from "./types.ts";

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
```

- [ ] **Step 10: Create the package index** (`packages/alerter/src/index.ts`)

```ts
/** Public surface of `@naikan/alerter` (issue #10). */
export type {
  Alert,
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
export { createLiveChannels } from "./channels.ts";
export { makeIncidentAlerter } from "./incident-alerter.ts";
```

> NOTE: `index.ts` references `channels.ts` (Task 2) and `incident-alerter.ts` (Task 3). It will not type-check until those exist — that is fine; the `bun test` for Tasks 1 imports the specific modules directly, not the index. Commit the index now; Tasks 2–3 complete it.

- [ ] **Step 11: Run install + both test files, expect PASS**

Run: `bun install` (registers the new workspace package), then `bun test packages/alerter/src/templates.test.ts packages/alerter/src/dispatch.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 12: Commit**

```bash
git add packages/alerter/package.json packages/alerter/src/types.ts packages/alerter/src/templates.ts packages/alerter/src/dispatch.ts packages/alerter/src/index.ts packages/alerter/src/templates.test.ts packages/alerter/src/dispatch.test.ts bun.lock
git commit -m "feat(alerter): dispatch + templates with channel adapters (#10)"
```

---

## Task 2: Live channel adapters (Resend email + Slack webhook)

**Files:**
- Create: `packages/alerter/src/channels.ts`
- Test: `packages/alerter/src/channels.test.ts`

- [ ] **Step 1: Write the failing test** (`packages/alerter/src/channels.test.ts`)

Uses an injected `fetch` so no real network is hit.

```ts
import { expect, test } from "bun:test";
import { createLiveChannels } from "./channels.ts";

type FetchArgs = { url: string; init: RequestInit };

function fetchRecorder(status = 200) {
  const calls: FetchArgs[] = [];
  const fetchImpl = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(new Response("ok", { status }));
  };
  return { calls, fetchImpl };
}

test("sendEmail POSTs to Resend with auth + from + recipients", async () => {
  const { calls, fetchImpl } = fetchRecorder();
  const channels = createLiveChannels({
    resendApiKey: "re_test",
    fromEmail: "alerts@example.com",
    fetchImpl,
  });
  await channels.sendEmail(["ops@acme.test"], { subject: "S", text: "B" });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://api.resend.com/emails");
  const headers = new Headers(calls[0]!.init.headers);
  expect(headers.get("authorization")).toBe("Bearer re_test");
  const body = JSON.parse(String(calls[0]!.init.body));
  expect(body.from).toBe("alerts@example.com");
  expect(body.to).toEqual(["ops@acme.test"]);
  expect(body.subject).toBe("S");
});

test("sendEmail throws on a non-2xx Resend response", async () => {
  const { fetchImpl } = fetchRecorder(422);
  const channels = createLiveChannels({ resendApiKey: "re_test", fromEmail: "a@b.c", fetchImpl });
  await expect(channels.sendEmail(["x@y.z"], { subject: "S", text: "B" })).rejects.toThrow();
});

test("postSlack POSTs the text payload to the webhook URL", async () => {
  const { calls, fetchImpl } = fetchRecorder();
  const channels = createLiveChannels({ resendApiKey: "re_test", fromEmail: "a@b.c", fetchImpl });
  await channels.postSlack("https://hooks.slack.com/services/x", "hello");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://hooks.slack.com/services/x");
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: "hello" });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `bun test packages/alerter/src/channels.test.ts` → Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (`packages/alerter/src/channels.ts`)

```ts
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
```

- [ ] **Step 4: Run it, expect PASS**

Run: `bun test packages/alerter/src/channels.test.ts` → Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/alerter/src/channels.ts packages/alerter/src/channels.test.ts
git commit -m "feat(alerter): live Resend + Slack webhook channel adapters (#10)"
```

---

## Task 3: `makeIncidentAlerter` — event → deep-link → dispatch

**Files:**
- Create: `packages/alerter/src/incident-alerter.ts`
- Test: `packages/alerter/src/incident-alerter.test.ts`

The orchestrator (Task 5) emits an `IncidentAlertEvent` (no dashboard URL — it has no base URL). `makeIncidentAlerter` closes over the channels + `appBaseUrl`, builds the deep-link `${appBaseUrl}/#/projects/:projectId` (web-admin hash route), maps the event to an `Alert`, and dispatches. It never throws.

- [ ] **Step 1: Write the failing test** (`packages/alerter/src/incident-alerter.test.ts`)

```ts
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
```

- [ ] **Step 2: Run it, expect FAIL** — `bun test packages/alerter/src/incident-alerter.test.ts`.

- [ ] **Step 3: Implement** (`packages/alerter/src/incident-alerter.ts`)

```ts
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
      projectName: event.projectName,
      checkLabel: event.checkLabel,
      error: event.error,
      openedAt: event.openedAt,
      dashboardUrl: url,
    };
  }
  return {
    kind: "recovered",
    projectName: event.projectName,
    checkLabel: event.checkLabel,
    openedAt: event.openedAt,
    closedAt: event.closedAt ?? event.openedAt,
    durationMs: event.durationMs ?? 0,
    dashboardUrl: url,
  };
}
```

- [ ] **Step 4: Run it + the whole package, expect PASS**

Run: `bun test packages/alerter/` → Expected: PASS (all alerter tests, index now type-resolves).

- [ ] **Step 5: Commit**

```bash
git add packages/alerter/src/incident-alerter.ts packages/alerter/src/incident-alerter.test.ts
git commit -m "feat(alerter): incident-event alerter with dashboard deep-link (#10)"
```

---

## Task 4: Add `slackWebhookUrl` to Project (migration + repo + stores)

**Files:**
- Create: `migrations/1830000000000_project-slack-webhook.js`
- Modify: `packages/config-repo/src/types.ts`, `repo.ts`, `pg-store.ts`
- Test: `packages/config-repo/src/repo.test.ts` (add cases)

- [ ] **Step 1: Write the migration** (`migrations/1830000000000_project-slack-webhook.js`)

```js
/**
 * Add `projects.slack_webhook_url` (issue #10) — the per-project Slack incoming-webhook
 * URL the alerter posts incident alerts to. Distinct from `slack_channel`, which is a
 * display label (`#name`); the webhook URL embeds its own target channel. Nullable:
 * a project with no webhook simply gets no Slack alerts (email may still be routed).
 * Plaintext for MVP (issue #10 AC) — a write-only/encrypted treatment can follow.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.addColumns("projects", {
    slack_webhook_url: { type: "text" },
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropColumns("projects", ["slack_webhook_url"]);
};
```

- [ ] **Step 2: Write failing repo tests** — add to `packages/config-repo/src/repo.test.ts`

(Append these tests. They assert create/patch round-trips and https validation.)

```ts
test("createProject stores a valid https slack webhook url", async () => {
  const repo = createConfigRepo(new InMemoryConfigStore());
  const project = await repo.createProject(
    { name: "Acme", slackWebhookUrl: "https://hooks.slack.com/services/T/B/x" },
    { id: "u1" },
  );
  expect(project.slackWebhookUrl).toBe("https://hooks.slack.com/services/T/B/x");
});

test("createProject defaults slackWebhookUrl to null and rejects non-https", async () => {
  const repo = createConfigRepo(new InMemoryConfigStore());
  const project = await repo.createProject({ name: "Acme" }, { id: "u1" });
  expect(project.slackWebhookUrl).toBeNull();
  await expect(
    repo.createProject({ name: "Bad", slackWebhookUrl: "http://insecure.test/x" }, { id: "u1" }),
  ).rejects.toThrow();
});

test("updateProject can set and clear the slack webhook url", async () => {
  const repo = createConfigRepo(new InMemoryConfigStore());
  const c = await repo.createProject({ name: "Acme" }, { id: "u1" });
  const set = await repo.updateProject(c.id, { slackWebhookUrl: "https://hooks.slack.com/x" }, { id: "u1" });
  expect(set!.slackWebhookUrl).toBe("https://hooks.slack.com/x");
  const cleared = await repo.updateProject(c.id, { slackWebhookUrl: null }, { id: "u1" });
  expect(cleared!.slackWebhookUrl).toBeNull();
});
```

- [ ] **Step 3: Run, expect FAIL**

Run: `bun test packages/config-repo/src/repo.test.ts` → Expected: FAIL (`slackWebhookUrl` not on type / undefined).

- [ ] **Step 4: Add the field to types** (`packages/config-repo/src/types.ts`)

In `interface Project`, after the `slackChannel` line (~line 19):
```ts
  /** Slack incoming-webhook URL for per-project alerts (#10). Null when unset. */
  slackWebhookUrl: string | null;
```
In `interface ProjectInput`, after its `slackChannel?` line (~line 221):
```ts
  slackWebhookUrl?: string | null;
```

- [ ] **Step 5: Validate + persist in the repo** (`packages/config-repo/src/repo.ts`)

Add to `PROJECT_FIELDS` (after `"slackChannel",`):
```ts
  "slackWebhookUrl",
```
In `normalizeProjectCreate`, after the `slackChannel:` line:
```ts
    slackWebhookUrl: normalizeWebhookUrl(input.slackWebhookUrl),
```
In `normalizeProjectPatch`, after the `slackChannel` block:
```ts
  if (patch.slackWebhookUrl !== undefined) {
    out.slackWebhookUrl = normalizeWebhookUrl(patch.slackWebhookUrl);
  }
```
Add the validator near `normalizeSlack`:
```ts
/** A Slack incoming-webhook URL must be a valid https URL; null/empty clears it. */
function normalizeWebhookUrl(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ValidationError("slackWebhookUrl", "Slack webhook must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new ValidationError("slackWebhookUrl", "Slack webhook URL must use https");
  }
  return trimmed;
}
```

- [ ] **Step 6: Map the column in pg-store** (`packages/config-repo/src/pg-store.ts`)

In `interface ProjectRow`, after `slack_channel`:
```ts
  slack_webhook_url: string | null;
```
In `toProject`, after `slackChannel: r.slack_channel,`:
```ts
    slackWebhookUrl: r.slack_webhook_url,
```
In `projects.insert`, extend the column list + values:
```ts
        const rows = await sql<ProjectRow[]>`
          insert into projects
            (id, name, contacts, slack_channel, slack_webhook_url, alert_emails, retention_days, assigned_manager_id, created_at, updated_at)
          values
            (${project.id}, ${project.name}, ${project.contacts}, ${project.slackChannel}, ${project.slackWebhookUrl},
             ${project.alertEmails}, ${project.retentionDays}, ${project.assignedManagerId},
             ${project.createdAt}, ${project.updatedAt})
          returning *`;
```
In `projectPatchRow`, after the `slackChannel` mapping:
```ts
  if (patch.slackWebhookUrl !== undefined) row.slack_webhook_url = patch.slackWebhookUrl;
```

(The `InMemoryConfigStore` needs **no change**: its `projects.insert`/`update` spread all fields and `clone` copies them.)

- [ ] **Step 7: Run repo tests, expect PASS**

Run: `bun test packages/config-repo/` → Expected: PASS (existing + 3 new).

- [ ] **Step 8: Commit**

```bash
git add migrations/1830000000000_project-slack-webhook.js packages/config-repo/src/types.ts packages/config-repo/src/repo.ts packages/config-repo/src/pg-store.ts packages/config-repo/src/repo.test.ts
git commit -m "feat(db): per-project slack_webhook_url + repo validation (#10)"
```

---

## Task 5: Orchestrator emits a resolved `IncidentAlertEvent`

**Files:**
- Modify: `packages/config-repo/package.json` (add `@naikan/alerter` dep)
- Modify: `packages/config-repo/src/incident-orchestrator.ts`
- Test: `packages/config-repo/src/incident-orchestrator.test.ts` (add alerting cases)

Extend `ApplyIncidentDeps` with an optional `alerter` callback. After a transition opens/closes, resolve the project (via check → site → project), build the `checkLabel` (`host(baseUrl) + path`), and emit the event. Keep the return type `Incident | null` (existing #09 tests + callers unchanged). The alerter call is awaited but its failures are the alerter's concern (it never throws — Task 3); the orchestrator does not wrap it.

- [ ] **Step 1: Add the dep** (`packages/config-repo/package.json`)

Add to `dependencies`:
```json
    "@naikan/alerter": "workspace:*",
```

- [ ] **Step 2: Write failing orchestrator tests** — append to `incident-orchestrator.test.ts`

```ts
import type { IncidentAlertEvent } from "@naikan/alerter";

test("opening an incident emits an 'opened' event with project routing + check label", async () => {
  const events: IncidentAlertEvent[] = [];
  const alerter = (e: IncidentAlertEvent) => (events.push(e), Promise.resolve());
  // Re-seed with routing on the project.
  repo = createConfigRepo(new InMemoryConfigStore());
  const project = await repo.createProject(
    { name: "Acme", alertEmails: ["ops@acme.test"], slackWebhookUrl: "https://hooks.slack.test/x" },
    actor,
  );
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  const check = await repo.createCheck({ siteId: site.id, path: "/health", alertAfterNFails: 2 }, actor);

  await repo.recordRun({ checkId: check.id, checkType: "heartbeat", startedAt: at(0), finishedAt: at(0), status: "fail", latencyMs: 0, error: "down" });
  await applyIncidentForRun({ repo, checkId: check.id, alerter });
  expect(events).toHaveLength(0); // 1 fail < 2, no transition

  await repo.recordRun({ checkId: check.id, checkType: "heartbeat", startedAt: at(60), finishedAt: at(60), status: "fail", latencyMs: 0, error: "still down" });
  await applyIncidentForRun({ repo, checkId: check.id, alerter });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: "opened",
    projectId: project.id,
    projectName: "Acme",
    checkLabel: "acme.test/health",
    error: "still down",
    routing: { alertEmails: ["ops@acme.test"], slackWebhookUrl: "https://hooks.slack.test/x" },
  });
});

test("closing an incident emits a 'recovered' event with duration", async () => {
  const events: IncidentAlertEvent[] = [];
  const alerter = (e: IncidentAlertEvent) => (events.push(e), Promise.resolve());
  // check has alertAfterNFails=5 from beforeEach.
  for (let i = 0; i < 5; i++) {
    await recordAndApply("fail", i * 60);
  }
  await applyIncidentForRun({ repo, checkId, alerter }); // already open, no new event (still-open path)
  await repo.recordRun({ checkId, checkType: "heartbeat", startedAt: at(360), finishedAt: at(360), status: "pass", latencyMs: 0, error: null });
  await applyIncidentForRun({ repo, checkId, alerter });
  await repo.recordRun({ checkId, checkType: "heartbeat", startedAt: at(420), finishedAt: at(420), status: "pass", latencyMs: 0, error: null });
  await applyIncidentForRun({ repo, checkId, alerter });

  const recovered = events.find((e) => e.kind === "recovered");
  expect(recovered).toBeDefined();
  expect(recovered!.durationMs).toBe(420_000); // 420s - 0s
  expect(recovered!.closedAt).toEqual(at(420));
});

test("re-applying after the transition does not emit a second event (idempotent)", async () => {
  const events: IncidentAlertEvent[] = [];
  const alerter = (e: IncidentAlertEvent) => (events.push(e), Promise.resolve());
  for (let i = 0; i < 5; i++) {
    await repo.recordRun({ checkId, checkType: "heartbeat", startedAt: at(i * 60), finishedAt: at(i * 60), status: "fail", latencyMs: 0, error: "down" });
    await applyIncidentForRun({ repo, checkId, alerter });
  }
  expect(events.filter((e) => e.kind === "opened")).toHaveLength(1);
  // Re-run the orchestrator with no new run: incident already open → still-open → no event.
  await applyIncidentForRun({ repo, checkId, alerter });
  expect(events.filter((e) => e.kind === "opened")).toHaveLength(1);
});
```

- [ ] **Step 3: Run, expect FAIL**

Run: `bun test packages/config-repo/src/incident-orchestrator.test.ts` → Expected: FAIL (`alerter` not in deps; events empty).

- [ ] **Step 4: Implement** (`packages/config-repo/src/incident-orchestrator.ts`)

Replace the header imports + `ApplyIncidentDeps` and extend the transition branches:

```ts
import { evaluateIncident, SUCCESSES_TO_CLOSE, type RunPoint } from "@naikan/incident-machine";
import type { IncidentAlertEvent } from "@naikan/alerter";
import type { ConfigRepo } from "./repo.ts";
import type { CheckRun, Incident } from "./types.ts";

export interface ApplyIncidentDeps {
  repo: ConfigRepo;
  /** The check whose just-recorded run should be evaluated. */
  checkId: string;
  /**
   * Optional incident-alert sink (#10). Called best-effort after a transition
   * opens or closes an incident; it owns its own failure handling and must not
   * throw. Omitted → incidents transition silently (the #09 behaviour).
   */
  alerter?: (event: IncidentAlertEvent) => Promise<void>;
}
```

In `applyIncidentForRun`, after computing `transition`, change the two transition branches to capture the incident, emit, and return:

```ts
  if (transition.kind === "opened") {
    const incident = await repo.openIncident({
      checkId,
      openedAt: transition.openedAt,
      runIds: trailingFailIds(tail),
    });
    if (deps.alerter) {
      const event = await resolveEvent(repo, checkId, "opened", incident, runs.at(-1)?.error ?? null);
      if (event) await deps.alerter(event);
    }
    return incident;
  }
  if (transition.kind === "closed-recovered" && open) {
    const closingPassIds = tail.slice(tail.length - SUCCESSES_TO_CLOSE).map((r) => r.id);
    const incident = await repo.closeIncident(open.id, {
      closedAt: transition.closedAt,
      runIds: [...new Set([...open.runIds, ...closingPassIds])],
    });
    if (deps.alerter && incident) {
      const event = await resolveEvent(repo, checkId, "recovered", incident, null);
      if (event) await deps.alerter(event);
    }
    return incident;
  }
  return null;
```

> NOTE: the machine's `RunPoint` (`{ status, startedAt }`) has no `error`. Pass the opening error from the persisted `tail` instead — its last element is the just-recorded run. Replace `runs.at(-1)?.error` above with the tail's last error: use `tail.at(-1)?.error ?? null` (the `tail` is `CheckRun[]`, which has `error`). Update the opened branch accordingly:
> ```ts
>       const event = await resolveEvent(repo, checkId, "opened", incident, tail.at(-1)?.error ?? null);
> ```

Add the resolver helper at the bottom of the file:

```ts
/**
 * Resolve the project routing + a readable check label for an incident, producing
 * the DB-free event the alerter consumes. Returns null if the check/site/project
 * chain is missing (deleted mid-flight) — alerting is then skipped.
 */
async function resolveEvent(
  repo: ConfigRepo,
  checkId: string,
  kind: "opened" | "recovered",
  incident: Incident,
  error: string | null,
): Promise<IncidentAlertEvent | null> {
  const check = await repo.getCheck(checkId);
  if (!check) return null;
  const site = await repo.getSite(check.siteId);
  if (!site) return null;
  const project = await repo.getProject(site.projectId);
  if (!project) return null;

  const durationMs =
    kind === "recovered" && incident.closedAt
      ? incident.closedAt.getTime() - incident.openedAt.getTime()
      : null;

  return {
    kind,
    projectId: project.id,
    projectName: project.name,
    routing: { alertEmails: project.alertEmails, slackWebhookUrl: project.slackWebhookUrl },
    checkLabel: `${hostOf(site.baseUrl)}${check.path}`,
    error: kind === "opened" ? error : null,
    openedAt: incident.openedAt,
    closedAt: kind === "recovered" ? incident.closedAt : null,
    durationMs,
  };
}

/** Host of a base URL, falling back to the raw string if unparseable. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
```

- [ ] **Step 5: Run config-repo tests, expect PASS**

Run: `bun install && bun test packages/config-repo/` → Expected: PASS (existing #09 cases + new alerting cases).

- [ ] **Step 6: Commit**

```bash
git add packages/config-repo/package.json packages/config-repo/src/incident-orchestrator.ts packages/config-repo/src/incident-orchestrator.test.ts bun.lock
git commit -m "feat(config-repo): orchestrator emits incident alert events (#10)"
```

---

## Task 6: Wire the apps (worker job + API run-now)

**Files:**
- Modify: `apps/worker/package.json`, `apps/worker/src/job.ts`, `apps/worker/src/index.ts`
- Modify: `apps/api/src/heartbeat/routes.ts`, `apps/api/src/index.ts`
- Test: `apps/worker/src/worker.test.ts` (add an end-to-end alerting case)

- [ ] **Step 1: Add the dep to the worker** (`apps/worker/package.json`)

Add to `dependencies`:
```json
    "@naikan/alerter": "workspace:*",
```

- [ ] **Step 2: Write a failing worker test** — append to `apps/worker/src/worker.test.ts`

```ts
import type { IncidentAlertEvent } from "@naikan/alerter";

test("runHeartbeatJob fires an opened alert event when an incident opens", async () => {
  const events: IncidentAlertEvent[] = [];
  const alerter = (e: IncidentAlertEvent) => (events.push(e), Promise.resolve());
  const project = await repo.createProject({ name: "Acme", alertEmails: ["ops@acme.test"] }, actor);
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  const check = await repo.createCheck({ siteId: site.id, path: "/health", alertAfterNFails: 2 }, actor);
  const failing: RunCheck = () =>
    Promise.resolve<CheckRunResult>({ status: "fail", startedAt: new Date(0), finishedAt: new Date(0), latencyMs: 0, error: "down" });

  await runHeartbeatJob(check.id, { repo, runCheck: failing, alerter });
  expect(events).toHaveLength(0); // 1 fail < 2
  await runHeartbeatJob(check.id, { repo, runCheck: failing, alerter });
  expect(events).toHaveLength(1);
  expect(events[0]!.kind).toBe("opened");
  expect(events[0]!.checkLabel).toBe("acme.test/health");
});
```

- [ ] **Step 3: Run, expect FAIL** — `bun test apps/worker/src/worker.test.ts` (alerter not accepted).

- [ ] **Step 4: Thread `alerter` through the job** (`apps/worker/src/job.ts`)

Extend imports + deps + the apply call:
```ts
import { applyIncidentForRun, type CheckRun, type ConfigRepo, type HeartbeatCheck } from "@naikan/config-repo";
import type { IncidentAlertEvent } from "@naikan/alerter";
```
```ts
export interface RunHeartbeatJobDeps {
  repo: ConfigRepo;
  /** Override the executor in tests; defaults to the real `runHeartbeat`. */
  runCheck?: RunCheck;
  /** Optional incident-alert sink (#10); omitted → silent transitions. */
  alerter?: (event: IncidentAlertEvent) => Promise<void>;
}
```
Change the apply line:
```ts
  await applyIncidentForRun({ repo, checkId: check.id, alerter: deps.alerter });
```

- [ ] **Step 5: Run, expect PASS** — `bun test apps/worker/` → all worker tests pass.

- [ ] **Step 6: Build + inject the live alerter in the worker entry** (`apps/worker/src/index.ts`)

Add imports:
```ts
import { createLiveChannels, makeIncidentAlerter } from "@naikan/alerter";
```
Add a builder near `connectionString()`:
```ts
/**
 * Build the incident alerter from env, or null when email isn't configured.
 * RESEND_API_KEY + ALERT_FROM_EMAIL enable email; APP_BASE_URL drives the
 * dashboard deep-link (defaults to localhost for dev). Slack routing is per-project
 * (the webhook URL on the Project), so it needs no global env.
 */
function buildAlerter() {
  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.ALERT_FROM_EMAIL;
  const appBaseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
  if (!resendApiKey || !fromEmail) {
    console.log("worker: alerting email not configured (RESEND_API_KEY/ALERT_FROM_EMAIL); Slack-only");
  }
  const channels = createLiveChannels({
    resendApiKey: resendApiKey ?? "",
    fromEmail: fromEmail ?? "",
  });
  return makeIncidentAlerter(channels, appBaseUrl);
}
```
In `main`, after building `repo`:
```ts
  const alerter = buildAlerter();
```
Change the task handler:
```ts
  const heartbeatRun: Task = async (payload) => {
    const { checkId } = payload as HeartbeatPayload;
    await runHeartbeatJob(checkId, { repo, alerter });
  };
```

> NOTE on the email-not-configured case: `createLiveChannels` with an empty key still returns adapters; a real `sendEmail` would 401 at Resend and `dispatch` marks email `failed` (best-effort, never throws). Slack still works per-project. This keeps dev/test booting without secrets. The live email path is exercised under the human merge gate.

- [ ] **Step 7: Add the option to the API heartbeat app** (`apps/api/src/heartbeat/routes.ts`)

Add to imports:
```ts
import type { IncidentAlertEvent } from "@naikan/alerter";
```
Extend `HeartbeatAppOptions`:
```ts
  /** Optional incident-alert sink (#10); omitted → silent transitions. */
  alerter?: (event: IncidentAlertEvent) => Promise<void>;
```
In `createHeartbeatApp`, capture it: `const { auth, repo } = opts;` → add `const alerter = opts.alerter;`
Change the run-now apply line:
```ts
    await applyIncidentForRun({ repo, checkId: check.id, alerter });
```

- [ ] **Step 8: Add `@naikan/alerter` to the API + wire it** 

`apps/api` has no `package.json` deps list shown for `@naikan/*`? It imports `@naikan/config-repo` already (workspace resolves by name). Add `@naikan/alerter` to `apps/api/package.json` `dependencies` for explicitness (mirror the worker), then in `apps/api/src/index.ts`:
```ts
import { createLiveChannels, makeIncidentAlerter } from "@naikan/alerter";
```
Before `createHeartbeatApp`:
```ts
// Incident alerter (issue #10): email via Resend, Slack via per-project webhook.
// Boots without secrets — email sends just fail best-effort until configured (human gate).
const alerter = makeIncidentAlerter(
  createLiveChannels({
    resendApiKey: process.env.RESEND_API_KEY ?? "",
    fromEmail: process.env.ALERT_FROM_EMAIL ?? "",
  }),
  process.env.APP_BASE_URL ?? "http://localhost:3000",
);
```
Change the heartbeat app construction:
```ts
app.route("/", createHeartbeatApp({ auth, repo: config, alerter }));
```

- [ ] **Step 9: Run worker + (any) api tests, expect PASS**

Run: `bun install && bun test apps/` → Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/worker/package.json apps/worker/src/job.ts apps/worker/src/index.ts apps/api/package.json apps/api/src/heartbeat/routes.ts apps/api/src/index.ts apps/worker/src/worker.test.ts bun.lock
git commit -m "feat(worker,api): wire incident alerter on CheckRun + run-now (#10)"
```

---

## Task 7: web-admin — Slack webhook URL form field

**Files:**
- Modify: `apps/web-admin/src/lib/api.ts`, `Projects.svelte`, `ProjectDetail.svelte`

- [ ] **Step 1: Extend the API types** (`apps/web-admin/src/lib/api.ts`)

In `interface Project`, after `slackChannel: string | null;`:
```ts
  slackWebhookUrl: string | null;
```
In `interface ProjectInput`, after `slackChannel: string | null;`:
```ts
  slackWebhookUrl: string | null;
```

- [ ] **Step 2: Create form** (`apps/web-admin/src/Projects.svelte`)

In `blankForm()` add `slackWebhookUrl: "",` (after `slackChannel: "",`).
In the `create` handler's `input` object, after `slackChannel: form.slackChannel.trim() || null,`:
```ts
      slackWebhookUrl: form.slackWebhookUrl.trim() || null,
```
Add the input field after the Slack channel `<div class="field">…#project-acme…</div>`:
```svelte
    <div class="field">
      <label for="cw">Slack webhook URL</label>
      <input
        id="cw"
        class="input"
        type="url"
        placeholder="https://hooks.slack.com/services/…"
        bind:value={form.slackWebhookUrl}
      />
    </div>
```

- [ ] **Step 3: Edit form** (`apps/web-admin/src/ProjectDetail.svelte`)

In `emptyForm()` add `slackWebhookUrl: "",`.
In `formFrom(c)` add `slackWebhookUrl: c.slackWebhookUrl ?? "",`.
In `save`'s `updateProject` patch, after `slackChannel: form.slackChannel.trim() || null,`:
```ts
        slackWebhookUrl: form.slackWebhookUrl.trim() || null,
```
Add the input after the Slack channel field in the edit form:
```svelte
      <div class="field">
        <label for="ew">Slack webhook URL</label>
        <input
          id="ew"
          class="input"
          type="url"
          placeholder="https://hooks.slack.com/services/…"
          bind:value={form.slackWebhookUrl}
        />
      </div>
```

- [ ] **Step 4: Typecheck the SPA**

Run: `bun run --cwd apps/web-admin check`
Expected: no new type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web-admin/src/lib/api.ts apps/web-admin/src/Projects.svelte apps/web-admin/src/ProjectDetail.svelte
git commit -m "feat(web-admin): slack webhook URL on the project form (#10)"
```

---

## Task 8: Env docs + final verification

**Files:**
- Modify: `.env.example`
- Verify: ADR-0003 (already records Resend — no change), full test suite.

- [ ] **Step 1: Document the new env vars** (`.env.example`)

Append:
```bash

# Incident alerting (issue #10 / ADR-0003).
# RESEND_API_KEY: transactional email via Resend (verify the sending domain first).
# ALERT_FROM_EMAIL: the verified "from" address for alert + digest email.
# APP_BASE_URL: public base URL of the dashboard, used for alert deep-links.
# Per-project Slack routing uses the webhook URL stored on each Project (no global env).
RESEND_API_KEY=
ALERT_FROM_EMAIL=alerts@example.com
APP_BASE_URL=http://localhost:3000
```

- [ ] **Step 2: Run the full test suite + SPA typecheck**

Run: `bun test && bun run --cwd apps/web-admin check`
Expected: all green.

- [ ] **Step 3: Confirm migration applies (if a dev DB is available)**

Run: `bun run migrate` (against a dev DB) → expect the `1830` migration to add `slack_webhook_url`. Skip if no DB; note it for the human gate.

- [ ] **Step 4: Commit**

```bash
git add .env.example
git commit -m "docs(env): document RESEND/ALERT_FROM/APP_BASE_URL for alerting (#10)"
```

- [ ] **Step 5: Update the issue file** — tick the acceptance criteria in `docs/mvp/issues/10-alerter-incident-wiring.md`, set Status to `ready-for-human` (the human merge gate: verify Resend domain, supply `RESEND_API_KEY` + a real Slack webhook, confirm a live `opened` + `closed-recovered` alert lands on both channels). Commit:

```bash
git add docs/mvp/issues/10-alerter-incident-wiring.md
git commit -m "docs(issue): mark #10 ready-for-human — alerter wired, human gate pending"
```

---

## Acceptance Criteria → Task map

- [x] **ADR-0003 records the email provider** — pre-existing (`docs/adr/0003-email-provider.md`). No change.
- **`alerter` module with one `dispatch(alert, routing)` entry point; channel adapters internal** → Task 1 (+ Task 2 adapters).
- **Slack webhook URL field on Project** → Task 4 (DB/repo) + Task 7 (UI). Plaintext for MVP per AC; write-only hardening noted as follow-up.
- **Templated subject + body for open + recovery; deep-link to dashboard** → Task 1 (templates) + Task 3 (deep-link build).
- **Idempotency: same transition does not double-send if orchestrator re-runs** → structural: Task 5 emits only on real state change (open incident → `still-open` → no event), verified by the idempotency test; Task 1 dispatch is best-effort so a retried job never re-sends.
- **Smoke test against a recording fake for both channels** → Tasks 1, 3 (recording fakes), Task 6 (end-to-end worker path). **Manual verification against real Resend + Slack** → Task 8 Step 5 human gate.

## Out of scope (noted follow-ups)
- CheckGroup `defaultAlertRouting` as an alert source (this MVP routes per-Project only).
- Write-only / encrypted storage of the Slack webhook URL (plaintext accepted for MVP; returned to authenticated viewers via the project GET).
- Retry/queue for failed alert sends (best-effort only; a provider outage drops the alert rather than double-sending).
