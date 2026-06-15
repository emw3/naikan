/**
 * Incidents (issue #09).
 *
 * - `check_id` is intentionally NOT a foreign key: incidents are polymorphic over
 *   check types (heartbeat now; uicheck in #11), mirroring `check_runs`. Deleting
 *   a check does not cascade here; the retention reaper (#17) prunes old rows.
 * - `closed_at` null means the incident is still open. The partial unique index
 *   enforces at most one open incident per check (the orchestrator also guards).
 * - `run_ids` is the CheckRun span (opening fails + closing successes), per the
 *   PRD `Incident(... runs[])` data model.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable("incidents", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    check_id: { type: "uuid", notNull: true },
    opened_at: { type: "timestamptz", notNull: true },
    closed_at: { type: "timestamptz" },
    run_ids: { type: "uuid[]", notNull: true, default: pgm.func("ARRAY[]::uuid[]") },
  });
  pgm.createIndex("incidents", "check_id");
  pgm.createIndex("incidents", "check_id", {
    unique: true,
    where: "closed_at IS NULL",
    name: "incidents_one_open_per_check",
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable("incidents");
};
