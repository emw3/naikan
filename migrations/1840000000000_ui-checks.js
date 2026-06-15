/**
 * UI checks (issue #11b).
 *
 * - `ui_checks.site_id` → sites(id) ON DELETE CASCADE: deleting a site (or its
 *   project) drops its UI checks, mirroring heartbeat_checks.
 * - `group_id` → check_groups(id) ON DELETE SET NULL (nullable): a UI check may
 *   inherit a CheckGroup's routing; clearing the group falls back to no group.
 * - `viewports` / `selectors` / `ignore_regions` are text[] (viewport *labels*
 *   plus CSS selectors); `perf_budget` is jsonb `{ lcpMs, pageWeightBytes, maxRequests }`.
 * - `baseline_image_ref`, `diff_threshold`, the per-signal severities, `selectors`,
 *   `ignore_regions`, and `perf_budget` are stored here but only consumed once
 *   diffing (#12) and signals (#13) land — #11b just persists + captures.
 * - The PRD defaults are column defaults so an empty admin submission still
 *   produces a working check.
 * - `check_runs.artifacts_ref` already exists (1800000000000_heartbeat-checks.js):
 *   a uicheck run stores its manifest key there. No change to check_runs here.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable("ui_checks", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    site_id: { type: "uuid", notNull: true, references: "sites", onDelete: "CASCADE" },
    group_id: { type: "uuid", references: "check_groups", onDelete: "SET NULL" },
    path: { type: "text", notNull: true, default: "/" },
    viewports: { type: "text[]", notNull: true, default: "{mobile,tablet,desktop}" },
    selectors: { type: "text[]", notNull: true, default: "{}" },
    ignore_regions: { type: "text[]", notNull: true, default: "{}" },
    perf_budget: {
      type: "jsonb",
      notNull: true,
      default: '{"lcpMs":2500,"pageWeightBytes":3145728,"maxRequests":100}',
    },
    diff_threshold: { type: "double precision", notNull: true, default: 0.01 },
    severity_load: { type: "text", notNull: true, default: "critical" },
    severity_console: { type: "text", notNull: true, default: "warning" },
    severity_selector: { type: "text", notNull: true, default: "warning" },
    severity_perf: { type: "text", notNull: true, default: "warning" },
    baseline_image_ref: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint(
    "ui_checks",
    "ui_checks_diff_threshold_range",
    "CHECK (diff_threshold >= 0 AND diff_threshold <= 1)",
  );
  for (const col of ["severity_load", "severity_console", "severity_selector", "severity_perf"]) {
    pgm.addConstraint(
      "ui_checks",
      `ui_checks_${col}_check`,
      `CHECK (${col} IN ('critical', 'warning'))`,
    );
  }
  pgm.createIndex("ui_checks", "site_id");
  pgm.createIndex("ui_checks", "group_id");
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable("ui_checks");
};
