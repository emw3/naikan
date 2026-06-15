import postgres from "postgres";

// Raw SQL via the `postgres` library — no ORM (per PRD line 74 / ADR / issue #01).
// The connection is created lazily so the API and /health boot without a live DB.

let sql: ReturnType<typeof postgres> | undefined;

/** Returns the shared Postgres project, creating it on first use. */
export function db(): ReturnType<typeof postgres> {
  if (!sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    sql = postgres(url);
  }
  return sql;
}

/** Closes the shared connection if one was opened. */
export async function closeDb(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = undefined;
  }
}
