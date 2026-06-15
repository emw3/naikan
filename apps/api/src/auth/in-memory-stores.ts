/**
 * In-memory implementations of `UserStore` / `SessionStore`.
 *
 * Used by the auth unit/integration tests (so they need no live Postgres, matching
 * the DB-free CI path established in issue #01) and usable as a stand-in during
 * local UI work. Production wiring uses the Postgres-backed stores instead.
 */
import type { Role, Session, SessionStore, User, UserRecord, UserStore } from "./types.ts";

function toSafeUser(r: UserRecord): User {
  return { id: r.id, email: r.email, role: r.role, createdAt: r.createdAt };
}

export class InMemoryUserStore implements UserStore {
  private readonly byId = new Map<string, UserRecord>();
  private seq = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  findByEmail(email: string): Promise<UserRecord | null> {
    const wanted = email.trim().toLowerCase();
    for (const r of this.byId.values()) {
      if (r.deletedAt === null && r.email === wanted) return Promise.resolve(r);
    }
    return Promise.resolve(null);
  }

  findById(id: string): Promise<UserRecord | null> {
    const r = this.byId.get(id);
    return Promise.resolve(r && r.deletedAt === null ? r : null);
  }

  list(): Promise<User[]> {
    const out = [...this.byId.values()]
      .filter((r) => r.deletedAt === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(toSafeUser);
    return Promise.resolve(out);
  }

  create(input: { email: string; passwordHash: string; role: Role }): Promise<User> {
    const email = input.email.trim().toLowerCase();
    for (const r of this.byId.values()) {
      if (r.deletedAt === null && r.email === email) {
        return Promise.reject(new Error(`email already in use: ${email}`));
      }
    }
    const record: UserRecord = {
      id: `user-${++this.seq}`,
      email,
      role: input.role,
      passwordHash: input.passwordHash,
      createdAt: this.now(),
      deletedAt: null,
    };
    this.byId.set(record.id, record);
    return Promise.resolve(toSafeUser(record));
  }

  setRole(id: string, role: Role): Promise<User | null> {
    const r = this.byId.get(id);
    if (!r || r.deletedAt !== null) return Promise.resolve(null);
    r.role = role;
    return Promise.resolve(toSafeUser(r));
  }

  softDelete(id: string): Promise<boolean> {
    const r = this.byId.get(id);
    if (!r || r.deletedAt !== null) return Promise.resolve(false);
    r.deletedAt = this.now();
    return Promise.resolve(true);
  }
}

export class InMemorySessionStore implements SessionStore {
  private readonly byId = new Map<string, Session>();

  create(session: Session): Promise<void> {
    this.byId.set(session.id, { ...session });
    return Promise.resolve();
  }

  find(id: string): Promise<Session | null> {
    const s = this.byId.get(id);
    return Promise.resolve(s ? { ...s } : null);
  }

  delete(id: string): Promise<void> {
    this.byId.delete(id);
    return Promise.resolve();
  }

  deleteByUser(userId: string): Promise<void> {
    for (const [id, s] of this.byId) {
      if (s.userId === userId) this.byId.delete(id);
    }
    return Promise.resolve();
  }
}
