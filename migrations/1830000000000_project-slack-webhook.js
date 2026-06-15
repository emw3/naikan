/**
 * Add `projects.slack_webhook_url` (issue #10) — the per-project Slack incoming-webhook
 * URL the alerter posts incident alerts to. Distinct from `slack_channel`, which is a
 * display label (`#name`); the webhook URL embeds its own target channel. Nullable:
 * a project with no webhook simply gets no Slack alerts (email may still be routed).
 * Plaintext for MVP (issue #10 AC) — a write-only/encrypted treatment can follow.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.addColumns("projects", {
    slack_webhook_url: { type: "text" },
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropColumns("projects", ["slack_webhook_url"]);
};
