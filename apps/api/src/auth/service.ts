/**
 * `auth` — email/password login, session lifecycle, and the user-admin operations
 * behind the admin Users screen (issue #03 / PRD module 9).
 *
 * The service is a deep module with a narrow interface: all persistence is injected
 * (`UserStore` / `SessionStore`) and the clock + token generator are injectable too,
 * so the lifecycle (issue, validate, expire, revoke) is unit-testable with in-memory
 * fakes and no live Postgres. Production wires Postgres-backed stores and the real
 * clock; cookie/HTTP concerns live in `middleware.ts` / `routes.ts`, not here.
 */
import { hashPassword, verifyPassword } from "./password.ts";
import type { Role, Session, SessionStore, User, UserStore } from "./types.ts";

export interface AuthDeps {
  users: UserStore;
  sessions: SessionStore;
  /** Clock, injectable for deterministic expiry tests. Defaults to wall clock. */
  now?: () => Date;
  /** Session lifetime in milliseconds. Defaults to 7 days. */
  sessionTtlMs?: number;
  /** Opaque session-token generator, injectable for tests. Defaults to 256-bit random. */
  generateToken?: () => string;
}

export interface Auth {
  login(email: string, password: string): Promise<{ session: Session; user: User } | null>;
  validateSession(token: string): Promise<User | null>;
  logout(token: string): Promise<void>;
  createUser(input: { email: string; password: string; role: Role }): Promise<User>;
  listUsers(): Promise<User[]>;
  changeRole(id: string, role: Role): Promise<User | null>;
  softDeleteUser(id: string): Promise<boolean>;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Generates a 256-bit URL-safe opaque token for use as a session id / cookie value. */
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export function createAuth(deps: AuthDeps): Auth {
  const { users, sessions } = deps;
  const now = deps.now ?? (() => new Date());
  const ttlMs = deps.sessionTtlMs ?? DEFAULT_TTL_MS;
  const generateToken = deps.generateToken ?? randomToken;

  return {
    async login(email, password) {
      // The store excludes soft-deleted users, so a deleted account is treated
      // the same as a missing one — both fail to log in.
      const record = await users.findByEmail(email);
      if (!record) return null;
      if (!(await verifyPassword(password, record.passwordHash))) return null;

      const issuedAt = now();
      const session: Session = {
        id: generateToken(),
        userId: record.id,
        createdAt: issuedAt,
        expiresAt: new Date(issuedAt.getTime() + ttlMs),
      };
      await sessions.create(session);
      return { session, user: toSafeUser(record) };
    },

    async validateSession(token) {
      const session = await sessions.find(token);
      if (!session) return null;
      if (session.expiresAt.getTime() <= now().getTime()) {
        await sessions.delete(token);
        return null;
      }
      // Resolve the user fresh each time so role changes take effect immediately
      // and soft-deleted users (excluded by the store) stop resolving.
      const record = await users.findById(session.userId);
      return record ? toSafeUser(record) : null;
    },

    async logout(token) {
      await sessions.delete(token);
    },

    async createUser(input) {
      const passwordHash = await hashPassword(input.password);
      return users.create({ email: input.email, passwordHash, role: input.role });
    },

    listUsers() {
      return users.list();
    },

    changeRole(id, role) {
      return users.setRole(id, role);
    },

    async softDeleteUser(id) {
      const deleted = await users.softDelete(id);
      // Revoke outstanding sessions so the cookie stops working immediately.
      if (deleted) await sessions.deleteByUser(id);
      return deleted;
    },
  };
}

function toSafeUser(r: User): User {
  return { id: r.id, email: r.email, role: r.role, createdAt: r.createdAt };
}
