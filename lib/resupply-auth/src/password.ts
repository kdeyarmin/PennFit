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
//
// Stage 4c — multi-algorithm verify:
//   The Clerk-to-in-house migration imports bcrypt password hashes
//   from Clerk's user-export CSV and stores them with
//   algo='clerk-bcrypt-v1'. verifyPasswordCredential() dispatches on
//   the algo tag: argon2id for new credentials, bcrypt-compare for
//   imported ones. On a successful bcrypt verify the result carries
//   `needsRehash: true` so the sign-in handler can transparently
//   upgrade the row to argon2id. After every imported user has
//   signed in once, no clerk-bcrypt-v1 rows remain and the bridge
//   is dead code (we keep it indefinitely; the cost is one
//   import + a small switch).

import { createHmac, timingSafeEqual } from "node:crypto";

import argon2 from "argon2";
// bcryptjs (pure JS) instead of native `bcrypt`. Bcrypt verification
// here is a one-shot migration path — every imported credential is
// rehashed to argon2id on first successful sign-in (see
// verifyPasswordCredential), so a sign-in costs ONE bcrypt compare
// per user lifetime. The native binding's speed advantage isn't
// worth the build-tooling dependency. Both libraries accept every
// $2a/$2b/$2y variant Clerk emits.
import bcrypt from "bcryptjs";

export interface PasswordHashParams {
  /** KiB of memory. Default 19_456 (≈19 MiB). */
  memoryCost?: number;
  /** Number of iterations. Default 2. */
  timeCost?: number;
  /** Parallelism (lanes). Default 1. */
  parallelism?: number;
}

/**
 * Tag identifying which algorithm a stored password_hash uses. The
 * value lives in `auth.password_credentials.algo` alongside the
 * hash itself, so verifyPasswordCredential can pick the right
 * verifier without parsing the hash string.
 *
 * "argon2id-v1" — peppered argon2id, the current default.
 * "clerk-bcrypt-v1" — bare bcrypt, NO pepper. Imported from a
 *     Clerk user-export CSV during the Stage 4c backfill. On a
 *     successful verify the credential is rehashed to
 *     argon2id-v1 (peppered) so subsequent sign-ins use the
 *     standard path.
 */
export type PasswordAlgo = "argon2id-v1" | "clerk-bcrypt-v1";

export const PASSWORD_ALGOS: readonly PasswordAlgo[] = [
  "argon2id-v1",
  "clerk-bcrypt-v1",
] as const;

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
 * Verify a plaintext password against a stored argon2id hash.
 * Returns false (not throws) for any verification failure — argon2's
 * verify can throw on malformed hashes, which we normalize to a deny.
 *
 * Most callers should use `verifyPasswordCredential` instead so the
 * algo dispatch + transparent rehash is handled in one place. This
 * function exists for the narrow case where the caller knows the
 * hash is argon2id (e.g. unit tests, fixed-format hashes).
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

export interface CredentialLike {
  passwordHash: string;
  /** Defaults to "argon2id-v1" when missing — historical rows. */
  algo?: string;
}

export interface VerifyCredentialResult {
  ok: boolean;
  /**
   * True iff the credential verified via a non-current algorithm
   * AND should be upgraded by the caller. Always false on a
   * verification failure.
   *
   * The caller upgrades by computing `hashPassword(plaintext)` and
   * writing the new hash + algo='argon2id-v1' to the row. The
   * upgrade is best-effort: if the write fails, the next sign-in
   * triggers another rehash attempt.
   */
  needsRehash: boolean;
}

/**
 * Multi-algorithm password verify. The credential carries its own
 * algo tag (default "argon2id-v1" for legacy rows that predate the
 * tag); we dispatch and return whether the row needs to be
 * rehashed.
 *
 * Failures are normalized to `{ ok: false, needsRehash: false }`;
 * the function never throws on malformed input.
 */
export async function verifyPasswordCredential(
  password: string,
  pepper: Buffer,
  credential: CredentialLike,
): Promise<VerifyCredentialResult> {
  const algo = (credential.algo ?? "argon2id-v1") as PasswordAlgo;
  switch (algo) {
    case "argon2id-v1": {
      const ok = await verifyPassword(password, pepper, credential.passwordHash);
      return { ok, needsRehash: false };
    }
    case "clerk-bcrypt-v1": {
      // Bcrypt's compare() accepts $2a$ / $2b$ / $2y$ variants and
      // reads the cost out of the digest itself, so we don't need
      // to know the cost factor Clerk used. NO pepper here — Clerk
      // hashes are unpeppered (see Stage 4c plan + WorkOS / Better
      // Auth / PropelAuth migration guides).
      let ok: boolean;
      try {
        ok = await bcrypt.compare(password, credential.passwordHash);
      } catch {
        ok = false;
      }
      return { ok, needsRehash: ok };
    }
    default: {
      // Unknown algo — fail closed.
      return { ok: false, needsRehash: false };
    }
  }
}

/**
 * True when an argon2id hash was produced with parameters weaker
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

// Re-export so the audit tests have a stable place to import the
// constant-time comparator from. Used by no production code today;
// keeping it here means a future "compare two hashes" call site
// has the right primitive ready.
export { timingSafeEqual };
