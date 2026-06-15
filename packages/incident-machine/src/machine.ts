/**
 * Pure incident state machine (issue #09).
 *
 * `evaluateIncident` decides what to do about a check's incident state given its
 * recent runs (oldest → newest), whether an incident is already open, and the
 * fails-to-open threshold. It is the single-step decision the orchestrator calls
 * after every CheckRun. No DB, no clock — everything is passed in.
 *
 * Rules (PRD behavioural rules): open after N consecutive fails; close after 2
 * consecutive successes. `opened_at` is the first fail of the trailing streak;
 * `closed_at` is the latest (recovery-confirming) run; the recovery duration is
 * `closed_at − opened_at`.
 */
import type { MachineInput, RunPoint, Transition } from "./types.ts";

/** Consecutive successful runs that close an open incident (PRD: hard-coded M = 2). */
export const SUCCESSES_TO_CLOSE = 2;

/** Decide the incident transition for the just-recorded run. */
export function evaluateIncident(input: MachineInput): Transition {
  const { runs, open, alertAfterNFails } = input;

  if (open) {
    if (trailingCount(runs, "pass") >= SUCCESSES_TO_CLOSE) {
      const closedAt = runs[runs.length - 1]!.startedAt;
      return {
        kind: "closed-recovered",
        openedAt: open.openedAt,
        closedAt,
        durationMs: closedAt.getTime() - open.openedAt.getTime(),
      };
    }
    return { kind: "still-open" };
  }

  const fails = trailingCount(runs, "fail");
  if (alertAfterNFails >= 1 && fails >= alertAfterNFails) {
    // opened_at = the first run of the trailing failing streak (within the window).
    return { kind: "opened", openedAt: runs[runs.length - fails]!.startedAt };
  }
  return { kind: "none" };
}

/**
 * Fold the single-step machine over a full run history (oldest → newest),
 * threading the open-incident state, and return every transition. This is the
 * table-driven test surface: (history, thresholds) → transitions. Each step sees
 * a trailing window of `max(N, 2)` runs — exactly what the orchestrator feeds in.
 */
export function replayIncidents(history: RunPoint[], alertAfterNFails: number): Transition[] {
  const windowSize = Math.max(alertAfterNFails, SUCCESSES_TO_CLOSE);
  const transitions: Transition[] = [];
  let open: { openedAt: Date } | null = null;
  for (let i = 0; i < history.length; i++) {
    const runs = history.slice(0, i + 1).slice(-windowSize);
    const t = evaluateIncident({ runs, open, alertAfterNFails });
    transitions.push(t);
    if (t.kind === "opened") open = { openedAt: t.openedAt };
    else if (t.kind === "closed-recovered") open = null;
  }
  return transitions;
}

/** Length of the run of `status` at the end of `runs`. */
function trailingCount(runs: RunPoint[], status: "pass" | "fail"): number {
  let n = 0;
  for (let i = runs.length - 1; i >= 0 && runs[i]!.status === status; i--) n++;
  return n;
}
