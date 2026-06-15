/**
 * Integration test for the daily digest job (issue #15) — the end-to-end demo
 * from the issue: a manager owning two projects receives ONE email summarising
 * both, and a Slack message lands in each project's channel.
 *
 * Exercises the real path — listProjects → gather runs/incidents in the window →
 * buildDigest → render → dispatch — against the in-memory config store with
 * recording fake channels and an injected clock. graphile-worker (the cron
 * transport, wired in index.ts) is deliberately absent.
 */
import { beforeEach, expect, test } from "bun:test";
import { createConfigRepo, InMemoryConfigStore, type Actor, type ConfigRepo } from "@naikan/config-repo";
import type { EmailMessage } from "@naikan/alerter";
import { runDigestSend, type DigestChannels } from "./digest-job.ts";

const actor: Actor = { id: "system" };
const NOW = new Date("2026-06-03T08:00:00.000Z");
/** A time inside the default 24h window ending at NOW. */
const inWindow = (hoursBefore: number): Date => new Date(NOW.getTime() - hoursBefore * 3_600_000);

interface SentEmail {
  to: string[];
  message: EmailMessage;
}
interface SentSlack {
  webhookUrl: string;
  text: string;
}

function recordingChannels(): {
  channels: DigestChannels;
  emails: SentEmail[];
  slacks: SentSlack[];
} {
  const emails: SentEmail[] = [];
  const slacks: SentSlack[] = [];
  return {
    emails,
    slacks,
    channels: {
      sendEmail: (to, message) => {
        emails.push({ to, message });
        return Promise.resolve();
      },
      postSlack: (webhookUrl, text) => {
        slacks.push({ webhookUrl, text });
        return Promise.resolve();
      },
    },
  };
}

let store: InMemoryConfigStore;
let repo: ConfigRepo;

beforeEach(() => {
  store = new InMemoryConfigStore();
  repo = createConfigRepo(store);
});

/** Seed a project with one heartbeat check that ran (pass/fail) inside the window. */
async function seedProject(opts: {
  name: string;
  managerId: string | null;
  webhook?: string | null;
  digestEmailEnabled?: boolean;
  digestSlackEnabled?: boolean;
  fails?: number;
  passes?: number;
}): Promise<string> {
  const project = await repo.createProject(
    {
      name: opts.name,
      assignedManagerId: opts.managerId,
      slackWebhookUrl: opts.webhook ?? null,
      digestEmailEnabled: opts.digestEmailEnabled ?? true,
      digestSlackEnabled: opts.digestSlackEnabled ?? true,
    },
    actor,
  );
  const host = `${opts.name.toLowerCase()}.test`;
  const site = await repo.createSite({ projectId: project.id, baseUrl: `https://${host}` }, actor);
  const check = await repo.createCheck({ siteId: site.id, path: "/health" }, actor);
  const record = (status: "pass" | "fail", h: number) =>
    repo.recordRun({
      checkId: check.id,
      checkType: "heartbeat",
      startedAt: inWindow(h),
      finishedAt: inWindow(h),
      status,
      latencyMs: 0,
      error: status === "fail" ? "HTTP 500" : null,
    });
  for (let i = 0; i < (opts.passes ?? 1); i++) await record("pass", 5 + i);
  for (let i = 0; i < (opts.fails ?? 0); i++) await record("fail", 2 + i);
  return project.id;
}

// ---- the issue's end-to-end demo ----

test("a manager with two projects gets one email; each project gets a Slack post", async () => {
  store.seedUser({ id: "mgr", email: "mara@example.com", role: "admin", deletedAt: null });
  await seedProject({ name: "Acme", managerId: "mgr", webhook: "https://hooks.slack/acme", fails: 1, passes: 3 });
  await seedProject({ name: "Beta", managerId: "mgr", webhook: "https://hooks.slack/beta", passes: 2 });

  const { channels, emails, slacks } = recordingChannels();
  const result = await runDigestSend({ repo, channels, appBaseUrl: "http://localhost:3000", now: () => NOW });

  // one aggregated email to the manager, covering both projects
  expect(emails).toHaveLength(1);
  expect(emails[0]!.to).toEqual(["mara@example.com"]);
  expect(emails[0]!.message.text).toContain("Acme");
  expect(emails[0]!.message.text).toContain("Beta");

  // one Slack post per project, to that project's webhook
  expect(slacks).toHaveLength(2);
  const byHook = Object.fromEntries(slacks.map((s) => [s.webhookUrl, s.text]));
  expect(byHook["https://hooks.slack/acme"]).toContain("Acme");
  expect(byHook["https://hooks.slack/beta"]).toContain("Beta");

  expect(result).toEqual({ projects: 2, emails: 1, slackPosts: 2 });
});

test("dashboard deep-links resolve to the per-project overview", async () => {
  store.seedUser({ id: "mgr", email: "mara@example.com", role: "admin", deletedAt: null });
  const id = await seedProject({ name: "Acme", managerId: "mgr", webhook: "https://hooks.slack/acme", passes: 1 });

  const { channels, emails, slacks } = recordingChannels();
  await runDigestSend({ repo, channels, appBaseUrl: "http://localhost:3000/", now: () => NOW });

  const link = `http://localhost:3000/#/projects/${id}`;
  expect(emails[0]!.message.text).toContain(link);
  expect(slacks[0]!.text).toContain(link);
});

// ---- per-Project toggles ----

test("digestEmailEnabled=false excludes a project from the email but Slack still posts", async () => {
  store.seedUser({ id: "mgr", email: "mara@example.com", role: "admin", deletedAt: null });
  await seedProject({ name: "Acme", managerId: "mgr", webhook: "https://hooks.slack/acme", digestEmailEnabled: false, passes: 1 });

  const { channels, emails, slacks } = recordingChannels();
  await runDigestSend({ repo, channels, appBaseUrl: "http://localhost:3000", now: () => NOW });

  // no email-enabled projects → no email
  expect(emails).toHaveLength(0);
  expect(slacks).toHaveLength(1);
});

test("digestSlackEnabled=false or no webhook suppresses the Slack post", async () => {
  store.seedUser({ id: "mgr", email: "mara@example.com", role: "admin", deletedAt: null });
  await seedProject({ name: "Acme", managerId: "mgr", webhook: "https://hooks.slack/acme", digestSlackEnabled: false, passes: 1 });
  await seedProject({ name: "Beta", managerId: "mgr", webhook: null, passes: 1 });

  const { channels, slacks } = recordingChannels();
  await runDigestSend({ repo, channels, appBaseUrl: "http://localhost:3000", now: () => NOW });

  expect(slacks).toHaveLength(0);
});

test("a project with no assigned manager is skipped for email but still posts Slack", async () => {
  await seedProject({ name: "Orphan", managerId: null, webhook: "https://hooks.slack/orphan", passes: 1 });

  const { channels, emails, slacks } = recordingChannels();
  const result = await runDigestSend({ repo, channels, appBaseUrl: "http://localhost:3000", now: () => NOW });

  expect(emails).toHaveLength(0);
  expect(slacks).toHaveLength(1);
  expect(result.projects).toBe(1);
});

test("a soft-deleted / unknown manager produces no email", async () => {
  store.seedUser({ id: "mgr", email: "gone@example.com", role: "admin", deletedAt: new Date() });
  await seedProject({ name: "Acme", managerId: "mgr", webhook: null, passes: 1 });

  const { channels, emails } = recordingChannels();
  await runDigestSend({ repo, channels, appBaseUrl: "http://localhost:3000", now: () => NOW });

  expect(emails).toHaveLength(0);
});

test("an opened incident in the window surfaces in the digest payload sections", async () => {
  store.seedUser({ id: "mgr", email: "mara@example.com", role: "admin", deletedAt: null });
  const project = await repo.createProject({ name: "Acme", assignedManagerId: "mgr" }, actor);
  const site = await repo.createSite({ projectId: project.id, baseUrl: "https://acme.test" }, actor);
  const check = await repo.createCheck({ siteId: site.id, path: "/health" }, actor);
  const run = await repo.recordRun({
    checkId: check.id,
    checkType: "heartbeat",
    startedAt: inWindow(4),
    finishedAt: inWindow(4),
    status: "fail",
    latencyMs: 0,
    error: "down",
  });
  await repo.openIncident({ checkId: check.id, openedAt: inWindow(4), runIds: [run.id] });

  const { channels, emails } = recordingChannels();
  await runDigestSend({ repo, channels, appBaseUrl: "http://localhost:3000", now: () => NOW });

  expect(emails[0]!.message.text.toLowerCase()).toContain("incident");
  expect(emails[0]!.message.text).toContain("acme.test/health");
});
