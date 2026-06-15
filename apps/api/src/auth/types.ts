/** The two flat roles (PRD: Admin = CRUD, Viewer = read). */
export type Role = "admin" | "viewer";

export const ROLES: readonly Role[] = ["admin", "viewer"];

export function isRole(value: unknown): value is Role {
  return value === "admin" || value === "viewer";
}

/** A user as exposed to callers — never carries the password hash. */
export interface User {
  id: string;
  email: string;
  role: Role;
  createdAt: Date;
}

/** A user as held by the store, including fields the service must not leak. */
export interface UserRecord extends User {
  passwordHash: string;
  deletedAt: Date | null;
}

/** A session is an opaque token (`id`) bound to a user with an expiry. */
export interface Session {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Persistence for users. Implementations exclude soft-deleted users from every
 * read (`findByEmail`, `findById`, `list`) so a deleted user cannot log in or
 * resolve from an existing session.
 */
export interface UserStore {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  list(): Promise<User[]>;
  create(input: { email: string; passwordHash: string; role: Role }): Promise<User>;
  setRole(id: string, role: Role): Promise<User | null>;
  softDelete(id: string): Promise<boolean>;
}

/** Persistence for sessions, keyed by the opaque token. */
export interface SessionStore {
  create(session: Session): Promise<void>;
  find(id: string): Promise<Session | null>;
  delete(id: string): Promise<void>;
  deleteByUser(userId: string): Promise<void>;
}
