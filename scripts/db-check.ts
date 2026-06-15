/**
 * Verifies the Postgres wiring: connect via the `postgres` library using
 * DATABASE_URL and run `select 1`. Exits non-zero on any failure.
 *
 * Requires a reachable Postgres (DATABASE_URL). Not part of the /health path.
 */
import { db, closeDb } from "../apps/api/src/db.ts";

try {
  const [row] = await db()`select 1 as ok`;
  if (row?.ok !== 1) throw new Error(`unexpected result: ${JSON.stringify(row)}`);
  console.log("db:check PASS — postgres reachable via DATABASE_URL");
  await closeDb();
  process.exit(0);
} catch (err) {
  console.error(`db:check FAIL — ${err instanceof Error ? err.message : String(err)}`);
  await closeDb();
  process.exit(1);
}
