/**
 * Pure CheckGroup inheritance resolution (issue #08).
 *
 * The single source of the PRD rule `effective = check ?? group ?? system`.
 * No DB, no clock — the check and its group (or null) are passed in, so the
 * decision is deterministic and unit-testable. The repo composes this over the
 * store (`getEffectiveCheck` / `listEffectiveChecks`); the scheduler tick reads
 * only the resolved result, so no consumer ever sees a raw null interval.
 */
import type {
  CheckGroup,
  EffectiveHeartbeatCheck,
  EffectiveUICheck,
  HeartbeatCheck,
  UICheck,
} from "./types.ts";

/** System fallback when neither the check nor its group sets an interval. */
export const SYSTEM_DEFAULT_INTERVAL_SECONDS = 300;
/** System fallback when neither the check nor its group sets alert-after-N-fails. */
export const SYSTEM_DEFAULT_ALERT_AFTER_N_FAILS = 1;
/**
 * Daily cadence (24h) — the system fallback for a UI check's interval when
 * neither the check nor its group sets one (PRD: UI checks run once per day, #14).
 */
export const SYSTEM_DEFAULT_UI_INTERVAL_SECONDS = 86_400;

/** Resolve a check's effective config against its group (or null when ungrouped). */
export function resolveEffectiveCheck(
  check: HeartbeatCheck,
  group: CheckGroup | null,
): EffectiveHeartbeatCheck {
  return {
    ...check,
    intervalSeconds:
      check.intervalSeconds ?? group?.defaultIntervalSeconds ?? SYSTEM_DEFAULT_INTERVAL_SECONDS,
    alertAfterNFails:
      check.alertAfterNFails ??
      group?.defaultAlertAfterNFails ??
      SYSTEM_DEFAULT_ALERT_AFTER_N_FAILS,
    alertRouting: group?.defaultAlertRouting ?? null,
  };
}

/**
 * Resolve a UI check's effective cadence against its group (or null when
 * ungrouped): `interval = check ?? group ?? daily`. Only the interval inherits —
 * UI incidents page on the first critical-signal fail (N fixed at 1), so there is
 * no per-check alert-after-N-fails to resolve here (#14).
 */
export function resolveEffectiveUICheck(
  check: UICheck,
  group: CheckGroup | null,
): EffectiveUICheck {
  return {
    ...check,
    intervalSeconds:
      check.intervalSeconds ?? group?.defaultIntervalSeconds ?? SYSTEM_DEFAULT_UI_INTERVAL_SECONDS,
  };
}
