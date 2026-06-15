/**
 * Postgres-backed `UserStore` / `SessionStore`, used to wire the auth service in
 * production. The behaviour mirrors the in-memory stores (which the tests pin):
 * every user read excludes soft-deleted rows, and emails are stored lowercased.
 *
 * The project is supplied as a getter (`() => Sql`) so it stays lazy: no Postgres
 * connection is opened until the first auth query actually runs, preserving the
 * "/health and static serving boot without a live DB" property from issue #01.
 */
import type postgres from "postgres";
import type { Role, Session, SessionStore, User, UserRecord, UserStore } from "./types.ts";

type Sql = ReturnType<typeof postgres>;

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  created_at: Date;
  deleted_at: Date | null;
}

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  };
}

function toSafeUser(row: { id: string; email: string; role: Role; created_at: Date }): User {
  return { id: row.id, email: row.email, role: row.role, createdAt: row.created_at };
}

export function createPgUserStore(getSql: () => Sql): UserStore {
  return {
    async findByEmail(email) {
      const sql = getSql();
      const rows = await sql<UserRow[]>`
        select * from users
        where lower(email) = lower(${email}) and deleted_at is null
        limit 1`;
      return rows[0] ? toRecord(rows[0]) : null;
    },

    async findById(id) {
      const sql = getSql();
      const rows = await sql<UserRow[]>`
        select * from users where id = ${id} and deleted_at is null limit 1`;
      return rows[0] ? toRecord(rows[0]) : null;
    },

    async list() {
      const sql = getSql();
      const rows = await sql<{ id: string; email: string; role: Role; created_at: Date }[]>`
        select id, email, role, created_at from users
        where deleted_at is null order by created_at`;
      return rows.map(toSafeUser);
    },

    async create(input) {
      const sql = getSql();
      const rows = await sql<{ id: string; email: string; role: Role; created_at: Date }[]>`
        insert into users (email, password_hash, role)
        values (${input.email.trim().toLowerCase()}, ${input.passwordHash}, ${input.role})
        returning id, email, role, created_at`;
      return toSafeUser(rows[0]!);
    },

    async setRole(id, role) {
      const sql = getSql();
      const rows = await sql<{ id: string; email: string; role: Role; created_at: Date }[]>`
        update users set role = ${role}
        where id = ${id} and deleted_at is null
        returning id, email, role, created_at`;
      return rows[0] ? toSafeUser(rows[0]) : null;
    },

    async softDelete(id) {
      const sql = getSql();
      const rows = await sql<{ id: string }[]>`
        update users set deleted_at = now()
        where id = ${id} and deleted_at is null
        returning id`;
      return rows.length > 0;
    },
  };
}

export function createPgSessionStore(getSql: () => Sql): SessionStore {
  return {
    async create(session) {
      const sql = getSql();
      await sql`
        insert into sessions (id, user_id, created_at, expires_at)
        values (${session.id}, ${session.userId}, ${session.createdAt}, ${session.expiresAt})`;
    },

    async find(id) {
      const sql = getSql();
      const rows = await sql<
        { id: string; user_id: string; created_at: Date; expires_at: Date }[]
      >`select id, user_id, created_at, expires_at from sessions where id = ${id} limit 1`;
      const row = rows[0];
      if (!row) return null;
      const s: Session = {
        id: row.id,
        userId: row.user_id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      };
      return s;
    },

    async delete(id) {
      const sql = getSql();
      await sql`delete from sessions where id = ${id}`;
    },

    async deleteByUser(userId) {
      const sql = getSql();
      await sql`delete from sessions where user_id = ${userId}`;
    },
  };
}
