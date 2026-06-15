/**
 * Baseline migration.
 *
 * Intentionally empty: running `node-pg-migrate up` against this establishes the
 * migration-tracking table (`pgmigrations`) and proves the forward/rollback wiring.
 * Real schema (Project, Site, checks, etc.) lands in later issues.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {};
