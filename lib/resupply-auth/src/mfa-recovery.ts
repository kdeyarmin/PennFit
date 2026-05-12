// Recovery codes for admin MFA.
//
// Single-use backup codes that an admin types in place of a TOTP
// code when their authenticator app is unavailable. See the
// rationale comment on the table schema in
// lib/resupply-db/src/schema/admin-mfa-recovery-codes.ts.
//
// Posture
// -------
//   * Each code is 8 chars from a no-confusables alphabet (32 chars,
//     omitting 0/O, 1/I/l). 8 chars × log2(32) = 40 bits per code —
//     enough that brute-force over a single code is infeasible, and
//     across a 10-code batch the attacker still needs ~2^36 guesses
//     to land any one. Pair with the existing login-attempt rate
//     limiter (which throttles per-email AND per-IP) and the
//     attack surface is negligible.
//   * Display format inserts a hyphen at position 4 ("ABCD-EFGH")
//     for legibility. The hyphen is stripped at compare time so
//     users can type with or without it.
//   * Codes are hashed with SHA-256 before storage. Recovery codes
//     are not as sensitive as passwords (single use, narrow scope,
//     issued by us not chosen by the user) so we don't need argon2 —
//     SHA-256 is the standard pattern (GitHub, AWS).
//   * Generation uses crypto.randomBytes (CSPRNG) with rejection
//     sampling to avoid modulo bias.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// No-confusables alphabet: 26 letters minus {O,I,L} = 23, plus
// digits 2-9 = 8, total 31. Not a power of two — rejection
// sampling (below) gives uniform draws without modulo bias.
// 31^8 ≈ 8.5e11 ≈ 2^39.6 of entropy per code.
const ALPHABET_USABLE = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export const RECOVERY_CODE_LENGTH = 8;
export const RECOVERY_CODE_COUNT = 10;

/** Random index into ALPHABET_USABLE using rejection sampling.
 *  Each byte of randomness gets a fresh draw if it falls in the
 *  unrepresentable tail, eliminating modulo bias. */
function pickAlphabetChar(): string {
  const n = ALPHABET_USABLE.length;
  // Largest multiple of n ≤ 256.
  const limit = Math.floor(256 / n) * n;
  for (;;) {
    const b = randomBytes(1)[0]!;
    if (b < limit) {
      return ALPHABET_USABLE.charAt(b % n);
    }
    // Reject and re-draw; expected loops ≈ 256/limit < 1.07.
  }
}

/** "ABCD-EFGH" — the display form shown to the admin once at
 *  enrollment verify. */
function formatForDisplay(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Strip whitespace + hyphens and uppercase, so "abcd-efgh" and
 *  "ABCDEFGH" (and even " abcd  efgh ") all compare equal. */
export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]+/g, "").toUpperCase();
}

/** Generate a single random recovery code in its normalized form
 *  (no hyphen). Exported only for tests; production should use
 *  generateRecoveryCodes which returns the whole batch. */
export function generateRecoveryCodeRaw(): string {
  let out = "";
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
    out += pickAlphabetChar();
  }
  return out;
}

export interface GeneratedRecoveryCode {
  /** Display form shown to the admin once ("ABCD-EFGH"). */
  display: string;
  /** Normalized (compare) form — no hyphen, uppercase. */
  normalized: string;
  /** SHA-256 hex of the normalized form. The DB stores this. */
  hash: string;
}

/** Mint a fresh batch of recovery codes. Default batch size is 10,
 *  matching the count GitHub / AWS show. Returns both the
 *  displayable forms (for the one-time show) AND the hashes (for
 *  insert) — the caller MUST insert the hashes and then return only
 *  the displays to the client; the plain text must never be
 *  persisted server-side. */
export function generateRecoveryCodes(
  count: number = RECOVERY_CODE_COUNT,
): GeneratedRecoveryCode[] {
  const codes: GeneratedRecoveryCode[] = [];
  const seen = new Set<string>();
  // Tiny defensive de-dup: 40 bits / 10 codes makes collisions a
  // 10^-10 event, but it costs nothing to be paranoid.
  while (codes.length < count) {
    const raw = generateRecoveryCodeRaw();
    if (seen.has(raw)) continue;
    seen.add(raw);
    codes.push({
      display: formatForDisplay(raw),
      normalized: raw,
      hash: hashRecoveryCode(raw),
    });
  }
  return codes;
}

/** SHA-256 hex of the (normalized) recovery code. */
export function hashRecoveryCode(normalizedCode: string): string {
  return createHash("sha256").update(normalizedCode, "utf8").digest("hex");
}

/** Constant-time compare of two SHA-256 hex strings. The verify
 *  path doesn't strictly need this (it does an indexed lookup by
 *  hash) but the helper is exported for any caller that wants to
 *  compare two known hashes without timing leakage. */
export function recoveryCodeHashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
