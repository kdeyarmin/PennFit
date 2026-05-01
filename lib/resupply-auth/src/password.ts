// Password hashing — argon2id with a server-side pepper.
//
// Why pepper-then-argon2 (and not argon2-with-secret):
//   * The `argon2` npm package's "secret" parameter is supported by
//     the underlying library but is not always plumbed through
//     consistently across versions and platforms. HMAC'ing the
//     password with the pepper before hashing achieves the same
//     security property (DB-only leak doesn't yield offline crack
//     candidates) using a primitive that's stable across every
//     argon2 release we'll touch.
//   * Pepper rotation, when it happens, is a one-shot re-hash on
//     next sign-in — same shape as a parameter drift.
//
// Why argon2id specifically:
//   * It's the OWASP-recommended password hash and the only one of
//     the modern KDFs that resists both side-channel and GPU attacks
//     simultaneously. bcrypt has a 72-byte truncation surprise;
//     scrypt's parameter tuning is finickier.
//
// Parameter target: ~250ms on prod hardware. Starting values:
//     memoryCost: 19_456 KiB (~ 19 MiB)
//     timeCost:   2 iterations
//     parallelism: 1
// These match OWASP's 2024 cheatsheet baseline for argon2id and are
// what we encode into stored hashes via the algo tag "argon2id-v1".

import { createHmac } from "node:crypto";

import argon2 from "argon2";

export interface PasswordHashParams {
  /** KiB of memory. Default 19_456 (≈19 MiB). */
  memoryCost?: number;
  /** Number of iterations. Default 2. */
  timeCost?: number;
  /** Parallelism (lanes). Default 1. */
  parallelism?: number;
}

const DEFAULT_PARAMS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Pre-hash step: HMAC-SHA256(password, pepper). The result is
 * 32 bytes; we hex-encode it before passing to argon2 so the hash
 * input is always a stable 64-char ASCII string regardless of the
 * user's password contents.
 */
export function pepperPassword(password: string, pepper: Buffer): string {
  if (pepper.length < 32) {
    throw new Error("pepper must be at least 32 bytes");
  }
  return createHmac("sha256", pepper).update(password, "utf8").digest("hex");
}

/**
 * Hash a plaintext password. Returns the encoded argon2id string —
 * algo+params+salt+hash all in one column-friendly value.
 */
export async function hashPassword(
  password: string,
  pepper: Buffer,
  params: PasswordHashParams = {},
): Promise<string> {
  const peppered = pepperPassword(password, pepper);
  return argon2.hash(peppered, {
    type: argon2.argon2id,
    ...DEFAULT_PARAMS,
    ...params,
  });
}

/**
 * Verify a plaintext password against a stored hash. Returns false
 * (not throws) for any verification failure — argon2's verify can
 * throw on malformed hashes, which we normalize to a deny.
 */
export async function verifyPassword(
  password: string,
  pepper: Buffer,
  storedHash: string,
): Promise<boolean> {
  const peppered = pepperPassword(password, pepper);
  try {
    return await argon2.verify(storedHash, peppered);
  } catch {
    return false;
  }
}

/**
 * True when the stored hash was produced with parameters weaker
 * than our current target. Call after a successful verify; if true,
 * re-hash the password and overwrite the row.
 *
 * argon2's `needsRehash` does the version + parameter inspection
 * for us; we just thread the current target through.
 */
export function needsRehash(
  storedHash: string,
  params: PasswordHashParams = {},
): boolean {
  return argon2.needsRehash(storedHash, {
    ...DEFAULT_PARAMS,
    ...params,
  });
}

/** Exposed for tests / introspection. */
export const PASSWORD_HASH_DEFAULTS = DEFAULT_PARAMS;
