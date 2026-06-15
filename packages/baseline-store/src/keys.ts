/**
 * Artifact key conventions for the S3-compatible store.
 *
 * Layout (committed to ADR-0002):
 *
 *   projects/<projectId>/checks/<checkId>/runs/<runId>/<viewport>.png        run screenshot
 *   projects/<projectId>/checks/<checkId>/runs/<runId>/<viewport>.diff.png   run diff overlay
 *   projects/<projectId>/checks/<checkId>/baseline/<viewport>.png            approved baseline
 *
 * Baselines deliberately live outside the `runs/` subtree so the retention
 * reaper (#17) can delete aged run artifacts by prefix while structurally
 * exempting the latest baseline. Key construction is centralised here so no
 * call site hand-builds a path.
 */

/** Reject segments that would corrupt the `/`-delimited key hierarchy. */
function segment(value: string): string {
  if (value.length === 0) {
    throw new Error("artifact key segment must not be empty");
  }
  if (value.includes("/")) {
    throw new Error(`artifact key segment must not contain "/": ${value}`);
  }
  return value;
}

export const artifactKeys = {
  /** Everything owned by one project — the unit the retention reaper scans. */
  projectPrefix(projectId: string): string {
    return `projects/${segment(projectId)}/`;
  },

  /** All run artifacts for one check (excludes the baseline subtree). */
  runsPrefix(projectId: string, checkId: string): string {
    return `projects/${segment(projectId)}/checks/${segment(checkId)}/runs/`;
  },

  /**
   * Everything one run produced (screenshots + diffs + manifest). The retention
   * reaper (#17) lists this prefix and deletes the lot — scoped to a single run
   * so a sibling run, and the baseline subtree, are never touched.
   */
  runPrefix(projectId: string, checkId: string, runId: string): string {
    return `${this.runsPrefix(projectId, checkId)}${segment(runId)}/`;
  },

  /** Approved-baseline artifacts for one check. */
  baselinePrefix(projectId: string, checkId: string): string {
    return `projects/${segment(projectId)}/checks/${segment(checkId)}/baseline/`;
  },

  /** Screenshot captured for a given run + viewport. */
  runScreenshot(projectId: string, checkId: string, runId: string, viewport: string): string {
    return `${this.runsPrefix(projectId, checkId)}${segment(runId)}/${segment(viewport)}.png`;
  },

  /** Diff overlay for a given run + viewport. */
  runDiff(projectId: string, checkId: string, runId: string, viewport: string): string {
    return `${this.runsPrefix(projectId, checkId)}${segment(runId)}/${segment(viewport)}.diff.png`;
  },

  /**
   * Per-run manifest recording what the run produced (viewports + screenshot
   * keys). Lives inside the run's own subtree so the retention reaper drops it
   * with the rest of the run. #12 adds `diffs`, #13 adds `signals` to its body.
   */
  runManifest(projectId: string, checkId: string, runId: string): string {
    return `${this.runsPrefix(projectId, checkId)}${segment(runId)}/manifest.json`;
  },

  /** Approved baseline for a given check + viewport. */
  baseline(projectId: string, checkId: string, viewport: string): string {
    return `${this.baselinePrefix(projectId, checkId)}${segment(viewport)}.png`;
  },

  /**
   * Manifest recording which run a check's current baseline was promoted from and
   * the per-viewport baseline keys. Lives in the baseline subtree (not under
   * `runs/`) so the retention reaper exempts it alongside the baseline images.
   * `UICheck.baselineImageRef` stores this key (#12).
   */
  baselineManifest(projectId: string, checkId: string): string {
    return `${this.baselinePrefix(projectId, checkId)}manifest.json`;
  },
};

/**
 * Sentinel written to `CheckRun.artifactsRef` once the retention reaper (#17)
 * deletes that run's artifacts. The `tombstone://` scheme can never collide with
 * a real artifact key (every key begins `projects/`), so readers distinguish three
 * states: `null` (run never produced artifacts, e.g. a heartbeat), a live key (a
 * loadable manifest), and this marker (artifacts existed but were reaped → the UI
 * shows an "artifacts expired" placeholder).
 */
export const TOMBSTONE_REF = "tombstone://expired";
