/**
 * Password hashing for the `auth` module.
 *
 * Uses Bun's built-in `Bun.password` (argon2id by default), which satisfies the
 * issue #03 "argon2 or bcrypt" requirement with no extra dependency. This is a
 * Bun-specific API and therefore lives under `apps/api` — never in the
 * runtime-agnostic kernel (ADR-0005).
 */

/** Hashes a plaintext password with argon2id. */
export function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: "argon2id" });
}

/**
 * Verifies a plaintext password against a stored hash. Returns false (rather
 * than throwing) on a malformed/unrecognised hash, so callers can treat any
 * non-match — including corrupt data — as a failed login.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(plain, hash);
  } catch {
    return false;
  }
}
