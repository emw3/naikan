/**
 * Heartbeat checks + check runs (issue #06).
 *
 * - `heartbeat_checks.site_id` → sites(id) ON DELETE CASCADE: deleting a site
 *   (or its project) drops its checks.
 * - `body_assertion` is nullable jsonb: `{ kind: 'regex'|'jsonpath', pattern, equals? }`.
 * - `interval_seconds` / `alert_after_n_fails` carry positive-value CHECKs (PRD).
 * - `check_runs.check_id` is intentionally NOT a foreign key: runs are polymorphic
 *   over check types (`check_type` discriminates heartbeat vs the uicheck arriving
 *   in #11), so they can't reference a single table. Indexed by (check_id, started_at)
 *   for "latest runs for this check" reads; the retention reaper (#17) prunes old rows.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable("heartbeat_checks", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    site_id: { type: "uuid", notNull: true, references: "sites", onDelete: "CASCADE" },
    path: { type: "text", notNull: true, default: "/" },
    body_assertion: { type: "jsonb" },
    cert_check: { type: "boolean", notNull: true, default: false },
    dns_check: { type: "boolean", notNull: true, default: false },
    interval_seconds: { type: "integer", notNull: true, default: 300 },
    alert_after_n_fails: { type: "integer", notNull: true, default: 1 },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint(
    "heartbeat_checks",
    "heartbeat_checks_interval_positive",
    "CHECK (interval_seconds > 0)",
  );
  pgm.addConstraint(
    "heartbeat_checks",
    "heartbeat_checks_alert_after_positive",
    "CHECK (alert_after_n_fails > 0)",
  );
  pgm.createIndex("heartbeat_checks", "site_id");

  pgm.createTable("check_runs", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    check_id: { type: "uuid", notNull: true },
    check_type: { type: "text", notNull: true },
    started_at: { type: "timestamptz", notNull: true },
    finished_at: { type: "timestamptz", notNull: true },
    status: { type: "text", notNull: true },
    latency_ms: { type: "integer", notNull: true },
    error: { type: "text" },
    artifacts_ref: { type: "text" },
  });
  pgm.addConstraint(
    "check_runs",
    "check_runs_check_type_check",
    "CHECK (check_type IN ('heartbeat', 'uicheck'))",
  );
  pgm.addConstraint("check_runs", "check_runs_status_check", "CHECK (status IN ('pass', 'fail'))");
  pgm.createIndex("check_runs", ["check_id", "started_at"]);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable("check_runs");
  pgm.dropTable("heartbeat_checks");
};
