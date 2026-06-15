/**
 * Config schema (issue #05): `projects`, `sites`, and the `audit_log` (PRD data model).
 *
 * - `projects.retention_days` defaults to 90 (PRD) with a positive-value CHECK.
 * - `projects.assigned_manager_id` → users(id); ON DELETE SET NULL so removing a user
 *   (users soft-delete, but be safe) doesn't orphan-block the project.
 * - `sites.project_id` → projects(id) ON DELETE CASCADE: deleting a project drops its sites.
 * - `audit_log.diff_json` is jsonb; `user_id` is nullable (system actions) with
 *   ON DELETE SET NULL. Indexed by (entity_type, entity_id) for per-entity history.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable("projects", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    name: { type: "text", notNull: true },
    contacts: { type: "text", notNull: true, default: "" },
    slack_channel: { type: "text" },
    alert_emails: { type: "text[]", notNull: true, default: "{}" },
    retention_days: { type: "integer", notNull: true, default: 90 },
    assigned_manager_id: { type: "uuid", references: "users", onDelete: "SET NULL" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("projects", "projects_retention_days_positive", "CHECK (retention_days > 0)");
  pgm.createIndex("projects", "assigned_manager_id");

  pgm.createTable("sites", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    project_id: { type: "uuid", notNull: true, references: "projects", onDelete: "CASCADE" },
    base_url: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("sites", "project_id");

  pgm.createTable("audit_log", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    user_id: { type: "uuid", references: "users", onDelete: "SET NULL" },
    entity_type: { type: "text", notNull: true },
    entity_id: { type: "uuid", notNull: true },
    action: { type: "text", notNull: true },
    diff_json: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint(
    "audit_log",
    "audit_log_action_check",
    "CHECK (action IN ('create', 'update', 'delete'))",
  );
  pgm.createIndex("audit_log", ["entity_type", "entity_id"]);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable("audit_log");
  pgm.dropTable("sites");
  pgm.dropTable("projects");
};
