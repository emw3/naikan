/**
 * Types for `@naikan/incident-machine` — the pure state machine that turns a
 * check's recent run history + thresholds into one incident state transition
 * (PRD deep module 4, issue #09).
 *
 * The machine reads no clock and no database: the recent runs, the open-incident
 * state, and the fails-to-open threshold are all passed in, so the decision is
 * deterministic and unit-testable. The orchestrator (config-repo) gathers these
 * from the repo after each CheckRun and applies the returned transition.
 */

/** The minimal projection of a CheckRun the machine reasons over. */
export interface RunPoint {
  /** Whether this run passed or failed. */
  status: "pass" | "fail";
  /** When the run started — anchors opened_at / closed_at and the recovery duration. */
  startedAt: Date;
}

/** The currently-open incident's start, or null when no incident is open for the check. */
export interface OpenState {
  openedAt: Date;
}

/** Inputs to one machine evaluation (after the latest run was recorded). */
export interface MachineInput {
  /** Recent runs for one check, oldest → newest; the newest is the run just recorded. */
  runs: RunPoint[];
  /** The open incident's start, or null if none is open. */
  open: OpenState | null;
  /** Consecutive failing runs required to open an incident (effective, inheritance resolved). */
  alertAfterNFails: number;
}

/** What the machine decides to do in response to the latest run. */
export type Transition =
  | { kind: "none" }
  | { kind: "opened"; openedAt: Date }
  | { kind: "still-open" }
  | { kind: "closed-recovered"; openedAt: Date; closedAt: Date; durationMs: number };
