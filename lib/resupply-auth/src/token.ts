// Opaque token helpers shared by sessions and email-tokens.
//
// The shape is deliberately the same for both kinds of token:
//   * 32 random bytes from `crypto.randomBytes`.
//   * base64url-encoded for transport (URL-safe; no padding).
//   * SHA-256 of the raw bytes is what gets persisted.
//
// 32 bytes = 256 bits of entropy, which is the standard "ample for
// session tokens, ample for email links" choice. base64url keeps
// the cookie / URL friendly for browsers and for our own logs (no
// `+`, `/`, `=` to escape).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Number of random bytes per token. */
export const TOKEN_BYTES = 32;
/** Length of the base64url string a token decodes to. */
export const TOKEN_STRING_LENGTH = 43; // ceil(32 * 8 / 6)

export interface IssuedToken {
  /** The raw token to send to the user (cookie value / URL param). */
  raw: string;
  /** sha256(raw bytes). What we persist. */
  hash: Buffer;
}

/** Generate a fresh token + its hash in one call. */
export function issueToken(): IssuedToken {
  const bytes = randomBytes(TOKEN_BYTES);
  const raw = bytes.toString("base64url");
  const hash = createHash("sha256").update(bytes).digest();
  return { raw, hash };
}

/**
 * Compute the persisted hash for a token string supplied by a
 * client. Returns null when the input doesn't decode to exactly
 * TOKEN_BYTES — the caller treats null as "invalid token" without
 * leaking which validation step failed.
 */
export function hashToken(raw: string): Buffer | null {
  if (typeof raw !== "string" || raw.length !== TOKEN_STRING_LENGTH) {
    return null;
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(raw, "base64url");
  } catch {
    return null;
  }
  if (bytes.length !== TOKEN_BYTES) {
    return null;
  }
  return createHash("sha256").update(bytes).digest();
}

/**
 * Constant-time comparison of two hash buffers. Use this when
 * verifying a stored hash against a freshly-computed one to avoid
 * the (theoretical) timing side channel of `Buffer.equals`.
 */
export function hashesEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
