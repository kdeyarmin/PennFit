// Password hashing — argon2id.
//
// The previous implementation HMAC'd the password with a server-side
// "pepper" before feeding it to argon2id. The pepper was removed in
// the Task #38 follow-up because the env-config requirement was
// causing repeated boot failures and the security uplift it provided
// (extra protection against an offline crack of a leaked DB) was not
// worth the operational cost for this app's threat model.
//
// Why argon2id specifically:
//   * It's the OWASP-recommended password hash and the only one of
//     the modern KDFs that resists both side-channel and GPU attacks
//     simultaneously. bcrypt has a 72-byte truncation surprise;
//     scrypt's parameter tuning is finickier.
//
// Historical note: earlier revisions of this module pre-hashed the
// password with HMAC-SHA256(password, pepper) before feeding it to
// argon2id, as a defense-in-depth measure against an offline DB
// dump. The pepper requirement was removed at the project owner's
// direction; argon2id alone is still a strong KDF, and a stored
// hash is not by itself a feasible offline crack target with the
// memory/time parameters we use.
//
// Parameter target: ~250ms on prod hardware. Starting values:
//     memoryCost: 19_456 KiB (~ 19 MiB)
//     timeCost:   2 iterations
//     parallelism: 1
// These match OWASP's 2024 cheatsheet baseline for argon2id and are
// what we encode into stored hashes via the algo tag "argon2id-v1".

import { timingSafeEqual } from "node:crypto";

import argon2 from "argon2";

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
 * "argon2id-v1" — argon2id, the current and only algorithm. The tag
 *     value was kept stable across the Task #38 pepper removal so
 *     the schema does not change, but be aware: hashes written
 *     before that removal were produced from
 *     `HMAC-SHA256(plaintext, pepper)` as the argon2id input, while
 *     hashes written after are produced from `plaintext` directly.
 *     `verifyPassword` no longer applies a pepper, so pre-removal
 *     rows will NOT validate — affected accounts must use the
 *     password-reset flow once. See ADR 014 "Amendment, Task #38".
 *     The tag column is kept for forward compatibility with future
 *     algorithm rotation (e.g. an argon2id-v2 with stronger
 *     parameters).
 */
export type PasswordAlgo = "argon2id-v1";

export const PASSWORD_ALGOS: readonly PasswordAlgo[] = ["argon2id-v1"] as const;

const DEFAULT_PARAMS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Hash a plaintext password. Returns the encoded argon2id string —
 * algo+params+salt+hash all in one column-friendly value.
 */
export async function hashPassword(
  password: string,
  params: PasswordHashParams = {},
): Promise<string> {
  return argon2.hash(password, {
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
  storedHash: string,
): Promise<boolean> {
  try {
    return await argon2.verify(storedHash, password);
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
   * Today there is exactly one algorithm (argon2id-v1) so this
   * field is always false on a successful verify; it's preserved
   * in the result shape so a future algorithm rotation can flip it
   * without a call-site change.
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
  credential: CredentialLike,
): Promise<VerifyCredentialResult> {
  const algo = (credential.algo ?? "argon2id-v1") as PasswordAlgo;
  switch (algo) {
    case "argon2id-v1": {
      const ok = await verifyPassword(password, credential.passwordHash);
      return { ok, needsRehash: false };
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
