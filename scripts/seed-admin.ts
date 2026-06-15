/**
 * Seeds the first admin user from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
 * (issue #03). Idempotent: if an active user with that email already exists it
 * leaves it untouched. Run after migrations: `bun run seed:admin`.
 *
 * Requires a reachable Postgres (DATABASE_URL) with the users table migrated.
 */
import { closeDb, db } from "../apps/api/src/db.ts";
import { createAuth } from "../apps/api/src/auth/service.ts";
import { createPgSessionStore, createPgUserStore } from "../apps/api/src/auth/pg-stores.ts";

const email = process.env.SEED_ADMIN_EMAIL;
const password = process.env.SEED_ADMIN_PASSWORD;

if (!email || !password) {
  console.error("seed:admin FAIL — set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD");
  process.exit(1);
}

const users = createPgUserStore(db);
const auth = createAuth({ users, sessions: createPgSessionStore(db) });

try {
  const existing = await users.findByEmail(email);
  if (existing) {
    console.log(`seed:admin SKIP — admin already exists: ${existing.email}`);
    await closeDb();
    process.exit(0);
  }
  const created = await auth.createUser({ email, password, role: "admin" });
  console.log(`seed:admin PASS — created admin ${created.email} (${created.id})`);
  await closeDb();
  process.exit(0);
} catch (err) {
  console.error(`seed:admin FAIL — ${err instanceof Error ? err.message : String(err)}`);
  await closeDb();
  process.exit(1);
}
