/**
 * Agent verdicts (Naikan agentic regression-judge).
 *
 * An AI agent — via the `@naikan/mcp` server + the bundled judging skill —
 * classifies whether a UI check run's screenshot diff is a *real* visual
 * regression or noise, and writes its verdict here. The web-admin run-detail view
 * surfaces the latest verdict next to the human promote-to-baseline action, so the
 * human stays in the loop (the agent advises; it does not auto-promote).
 *
 * - `run_id` → check_runs(id) ON DELETE CASCADE: a verdict is meaningless without
 *   the run it judges. check_runs rows survive the retention reaper (#17 only
 *   tombstones artifacts, never the row), so a verdict persists with its run.
 * - Multiple verdicts per run are allowed on purpose — re-judging, comparing
 *   models, and the eval suite all record more than one. `getLatestVerdict` and the
 *   UI read the newest; `listVerdicts` reads the history. Like `check_runs` and
 *   `incidents`, verdicts are agent-generated telemetry and are NOT audited.
 * - `confidence` is the agent's self-reported 0..1 confidence (nullable).
 * - `model` records which model produced the verdict — provenance the eval suite
 *   slices precision/recall by.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable("agent_verdicts", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    run_id: { type: "uuid", notNull: true, references: "check_runs", onDelete: "CASCADE" },
    verdict: { type: "text", notNull: true },
    confidence: { type: "real" },
    reasoning: { type: "text", notNull: true },
    model: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint(
    "agent_verdicts",
    "agent_verdicts_verdict_valid",
    "CHECK (verdict IN ('real_regression', 'noise', 'intentional', 'uncertain'))",
  );
  pgm.addConstraint(
    "agent_verdicts",
    "agent_verdicts_confidence_range",
    "CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))",
  );
  pgm.createIndex("agent_verdicts", "run_id");
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropTable("agent_verdicts");
};
