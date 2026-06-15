/**
 * Retention reaper (issue #17) — the daily counterpart to the digest, deleting
 * aged UI-check artifacts so the object store doesn't grow without bound.
 *
 * Per Project, runs whose `started_at` is older than `Project.retentionDays` lose
 * their per-viewport screenshots, diff overlays, and manifest from the artifact
 * store. The CheckRun row is kept (history is cheap) but its `artifactsRef` is
 * rewritten to `TOMBSTONE_REF`, so the dashboard renders "artifacts expired"
 * instead of trying to presign deleted keys.
 *
 * Baselines are exempt structurally, not by special-casing: they live outside the
 * `runs/` subtree (ADR-0002) and a promotion *copies* the bytes there, so reaping a
 * run by its `runPrefix` can never touch the approved baseline a check diffs against.
 * Only UI checks carry artifacts; heartbeat runs (null `artifactsRef`) are skipped.
 *
 * Repo, store, and clock are injected so the whole path is testable against the
 * in-memory store + a recording fake (no graphile-worker, no live S3).
 */
import type { ArtifactStore } from "@naikan/baseline-store";
import { artifactKeys, TOMBSTONE_REF } from "@naikan/baseline-store";
import type { ConfigRepo } from "@naikan/config-repo";

/** The reaper only deletes — it lists a run's subtree and removes each key. */
export type ReaperStore = Pick<ArtifactStore, "list" | "delete">;

export interface RunRetentionReaperDeps {
  repo: ConfigRepo;
  store: ReaperStore;
  /** Current time, injected for determinism. Each project's window ends here. */
  now: () => Date;
}

/** What one reaper pass deleted. */
export interface RetentionReaperResult {
  /** Projects scanned (every project, regardless of whether anything was reaped). */
  projects: number;
  /** Runs whose artifacts were deleted and which were tombstoned this pass. */
  runsReaped: number;
  /** Individual object keys deleted across all runs. */
  keysDeleted: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Lower bound for the "older than retention" window — the dawn of time. */
const EPOCH = new Date(0);

/** Run one retention pass over every project's UI-check runs. Returns what it deleted. */
export async function runRetentionReaper(deps: RunRetentionReaperDeps): Promise<RetentionReaperResult> {
  const { repo, store } = deps;
  const now = deps.now();

  let runsReaped = 0;
  let keysDeleted = 0;

  const projects = await repo.listProjects();
  for (const project of projects) {
    const cutoff = new Date(now.getTime() - project.retentionDays * DAY_MS);
    const sites = await repo.listSites(project.id);
    for (const site of sites) {
      const uichecks = await repo.listUIChecks(site.id);
      for (const check of uichecks) {
        // Runs older than the project's window. A live `artifactsRef` (a manifest
        // key, not null and not an already-written tombstone) means there are
        // artifacts left to delete; null/tombstoned runs are skipped (idempotent).
        const aged = await repo.listRunsInWindow(check.id, EPOCH, cutoff);
        for (const run of aged) {
          if (!run.artifactsRef || run.artifactsRef === TOMBSTONE_REF) continue;
          // Order matters: delete artifacts FIRST, write the tombstone LAST. If the
          // tombstone write fails after the delete, the run keeps its live ref and
          // the next daily pass re-reaps it (re-listing the empty prefix is a no-op),
          // so storage is always reclaimed — it self-heals. The reverse order would
          // skip a tombstoned-but-undeleted run forever, leaking its objects.
          // Until the retry, the API's manifest-load try/catch degrades gracefully.
          const keys = await store.list(artifactKeys.runPrefix(project.id, check.id, run.id));
          for (const key of keys) {
            await store.delete(key);
            keysDeleted += 1;
          }
          await repo.setRunArtifactsRef(run.id, TOMBSTONE_REF);
          runsReaped += 1;
        }
      }
    }
  }

  return { projects: projects.length, runsReaped, keysDeleted };
}
