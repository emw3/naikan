/**
 * CheckGroups + HeartbeatCheck inheritance (issue #08).
 *
 * - `check_groups.project_id` → projects(id) ON DELETE CASCADE: deleting a project
 *   drops its groups (matching sites).
 * - default_* columns are nullable: a null group default means "fall through to
 *   the system default" (effective = check ?? group ?? system).
 * - `default_alert_routing` is nullable jsonb: `{ slackChannel, alertEmails[] }`.
 * - `heartbeat_checks.group_id` → check_groups(id) ON DELETE SET NULL: deleting a
 *   group leaves its checks ungrouped (they fall back to the system default).
 * - `heartbeat_checks.interval_seconds` / `alert_after_n_fails` become nullable
 *   (null = inherit from the group). The positive-value CHECKs are relaxed to
 *   allow null.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable("check_groups", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    project_id: { type: "uuid", notNull: true, references: "projects", onDelete: "CASCADE" },
    name: { type: "text", notNull: true },
    default_interval_seconds: { type: "integer" },
    default_alert_routing: { type: "jsonb" },
    default_alert_after_n_fails: { type: "integer" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint(
    "check_groups",
    "check_groups_interval_positive",
    "CHECK (default_interval_seconds IS NULL OR default_interval_seconds > 0)",
  );
  pgm.addConstraint(
    "check_groups",
    "check_groups_alert_after_positive",
    "CHECK (default_alert_after_n_fails IS NULL OR default_alert_after_n_fails > 0)",
  );
  pgm.createIndex("check_groups", "project_id");

  // heartbeat_checks: add the FK + relax interval/alert columns to nullable (inherit).
  pgm.addColumn("heartbeat_checks", {
    group_id: { type: "uuid", references: "check_groups", onDelete: "SET NULL" },
  });
  pgm.createIndex("heartbeat_checks", "group_id");

  pgm.alterColumn("heartbeat_checks", "interval_seconds", { notNull: false, default: null });
  pgm.alterColumn("heartbeat_checks", "alert_after_n_fails", { notNull: false, default: null });

  pgm.dropConstraint("heartbeat_checks", "heartbeat_checks_interval_positive");
  pgm.dropConstraint("heartbeat_checks", "heartbeat_checks_alert_after_positive");
  pgm.addConstraint(
    "heartbeat_checks",
    "heartbeat_checks_interval_positive",
    "CHECK (interval_seconds IS NULL OR interval_seconds > 0)",
  );
  pgm.addConstraint(
    "heartbeat_checks",
    "heartbeat_checks_alert_after_positive",
    "CHECK (alert_after_n_fails IS NULL OR alert_after_n_fails > 0)",
  );
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropConstraint("heartbeat_checks", "heartbeat_checks_interval_positive");
  pgm.dropConstraint("heartbeat_checks", "heartbeat_checks_alert_after_positive");
  pgm.dropIndex("heartbeat_checks", "group_id");
  pgm.dropColumn("heartbeat_checks", "group_id");
  pgm.alterColumn("heartbeat_checks", "interval_seconds", { notNull: true, default: 300 });
  pgm.alterColumn("heartbeat_checks", "alert_after_n_fails", { notNull: true, default: 1 });
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
  pgm.dropTable("check_groups");
};
