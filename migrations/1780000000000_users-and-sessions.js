/**
 * Auth schema (issue #03): the `users` table (PRD data model) and a `sessions`
 * table backing opaque session-cookie tokens.
 *
 * - `users.role` is constrained to the two flat roles.
 * - Soft-delete via `deleted_at`; a partial unique index on `lower(email)` keeps
 *   active emails unique while letting a deleted email be re-used.
 * - `sessions.id` IS the opaque cookie token (not a uuid); rows cascade-delete
 *   with their user.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  // gen_random_uuid() — built into PG13+, but pgcrypto makes it explicit/portable.
  pgm.createExtension("pgcrypto", { ifNotExists: true });

  pgm.createTable("users", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    email: { type: "text", notNull: true },
    password_hash: { type: "text", notNull: true },
    role: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    deleted_at: { type: "timestamptz" },
  });
  pgm.addConstraint("users", "users_role_check", "CHECK (role IN ('admin', 'viewer'))");
  pgm.sql(
    "CREATE UNIQUE INDEX users_email_active_unique ON users (lower(email)) WHERE deleted_at IS NULL;",
  );

  pgm.createTable("sessions", {
    id: { type: "text", primaryKey: true },
    user_id: { type: "uuid", notNull: true, references: "users", onDelete: "CASCADE" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    expires_at: { type: "timestamptz", notNull: true },
  });
  pgm.createIndex("sessions", "user_id");
  pgm.createIndex("sessions", "expires_at");
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable("sessions");
  pgm.dropTable("users");
};
