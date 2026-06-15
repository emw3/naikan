/**
 * UI check daily scheduling + critical-fail incident signal (issue #14).
 *
 * - `ui_checks.interval_seconds` (nullable, null = inherit): the per-check run
 *   cadence. Mirrors `heartbeat_checks.interval_seconds` after #08 relaxed it to
 *   nullable. null falls through to the group default, then the system default
 *   (once daily). Positive-value CHECK allows null.
 * - `check_runs.critical_failed` (nullable boolean): for a uicheck run, whether a
 *   `critical`-severity Signal failed — the incident-relevant predicate, distinct
 *   from `status` (which fails on *any* signal/regression, for the digest). null
 *   for heartbeat runs, whose `status` is itself the incident signal.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.addColumn("ui_checks", {
    interval_seconds: { type: "integer" },
  });
  pgm.addConstraint(
    "ui_checks",
    "ui_checks_interval_positive",
    "CHECK (interval_seconds IS NULL OR interval_seconds > 0)",
  );

  pgm.addColumn("check_runs", {
    critical_failed: { type: "boolean" },
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropColumn("check_runs", "critical_failed");
  pgm.dropConstraint("ui_checks", "ui_checks_interval_positive");
  pgm.dropColumn("ui_checks", "interval_seconds");
};
