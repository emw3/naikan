/**
 * Per-Project daily-digest opt-ins (issue #15).
 *
 * - `projects.digest_email_enabled`: include this project in its manager's digest email.
 * - `projects.digest_slack_enabled`: post this project's digest to its Slack channel.
 *
 * Both default true (existing projects keep getting digests) and are NOT NULL.
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.addColumns("projects", {
    digest_email_enabled: { type: "boolean", notNull: true, default: true },
    digest_slack_enabled: { type: "boolean", notNull: true, default: true },
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropColumns("projects", ["digest_email_enabled", "digest_slack_enabled"]);
};
