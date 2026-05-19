// RFC 6238 TOTP helper.
//
// Authenticator apps (Google Authenticator, Authy, 1Password, etc.)
// implement RFC 6238 with HMAC-SHA1, 30-second step, 6 digits — the
// canonical defaults. We deliberately match the defaults exactly so
// any standard authenticator works without configuration.
//
// Why inline (no otplib / speakeasy)
// ----------------------------------
// The core math is ~50 lines. otplib has had vulnerabilities (most
// recently CVE-2023-36665 in the v12.x line) and is on its second
// major version with breaking API changes between them — that's
// more upkeep cost than the value the wrapper adds. The Node
// `crypto` module ships HMAC-SHA1 and the base32 encoder is RFC
// 4648 §6. The helper is small enough to read end-to-end and
// covered by RFC test vectors.
//
// Two surfaces:
//   * generateBase32Secret(bytes) — 160-bit random secret in base32
//   * buildOtpauthUri(opts) — provisioning URI an authenticator
//     decodes from a QR (otpauth://totp/...)
//   * verifyTotpCode(secret, code, opts) — accept a 6-digit code
//     with a ± step window for clock skew. Returns the matched
//     window position so the caller can store last_used_at AND
//     reject replays (same counter in the same window twice).

import { createHmac, randomBytes } from "node:crypto";

/** RFC 6238 default — 30-second step. */
export const TOTP_STEP_SECONDS = 30;
/** RFC 6238 default — 6 decimal digits. */
export const TOTP_DIGITS = 6;
/** RFC 4648 base32 alphabet. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Generate a fresh 160-bit (20-byte) shared secret encoded as
 * base32. 160 bits is the RFC 6238 reference key size for
 * HMAC-SHA1.
 */
export function generateBase32Secret(byteLength = 20): string {
  if (byteLength < 10 || byteLength > 64) {
    throw new RangeError(
      `TOTP secret byteLength must be in [10, 64]; got ${byteLength}`,
    );
  }
  return base32Encode(randomBytes(byteLength));
}

/**
 * Build the standard otpauth:// provisioning URI an authenticator
 * decodes from a QR. The label is what the authenticator displays
 * for this account; the issuer disambiguates when a user has
 * multiple PennPaps accounts (rare, but the spec mandates it).
 */
export function buildOtpauthUri(opts: {
  label: string; // e.g. "csr@penn.example"
  issuer: string; // e.g. "PennPaps"
  secret: string; // base32, no padding
}): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.label}`);
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export interface VerifyTotpOptions {
  /** Allow ± N steps of clock skew. The RFC suggests ±1; we default
   *  to 1 step (= 30s either side) which is enough for typical
   *  device clock drift without widening the replay window. */
  window?: number;
  /** Inject `now` for tests; default = Date.now(). */
  nowMs?: number;
  /** Reject codes whose matched counter is ≤ this. Use the value
   *  saved from the previous successful verify (the route layer
   *  persists it on admin_mfa_secrets.last_used_counter). Prevents
   *  someone who shoulder-surfed a 6-digit code from replaying it
   *  inside the 30-second window. */
  minCounter?: number;
}

export interface VerifyTotpResult {
  ok: boolean;
  /** The counter (= Math.floor(unix_seconds / step)) that matched.
   *  Null when ok=false. The caller persists this as the new
   *  minCounter so the next verify rejects ≤ this value. */
  counter: number | null;
}

/**
 * Verify a 6-digit code against the shared secret.
 *
 * Returns the matched counter so the caller can both (a) record
 * `last_used_at` and (b) bump `last_used_counter` to prevent a
 * replay within the same step window.
 */
export function verifyTotpCode(
  secretBase32: string,
  code: string,
  opts: VerifyTotpOptions = {},
): VerifyTotpResult {
  if (!/^\d{6}$/.test(code)) return { ok: false, counter: null };
  const secret = base32Decode(secretBase32);
  if (secret.length === 0) return { ok: false, counter: null };

  const window = Math.max(0, Math.floor(opts.window ?? 1));
  const nowSeconds = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const baseCounter = Math.floor(nowSeconds / TOTP_STEP_SECONDS);
  const minCounter = opts.minCounter ?? -Infinity;

  // Iterate the window from earliest to latest so the EARLIEST
  // matching counter wins. That ensures replay rejection works
  // even when the code is valid in two adjacent windows (boundary
  // case at the second the counter ticks over).
  for (let offset = -window; offset <= window; offset++) {
    const counter = baseCounter + offset;
    if (counter <= minCounter) continue;
    const expected = hotpCode(secret, counter, TOTP_DIGITS);
    if (constantTimeEquals(expected, code)) {
      return { ok: true, counter };
    }
  }
  return { ok: false, counter: null };
}

/**
 * The HOTP primitive (RFC 4226 §5) that TOTP wraps. Exported for
 * testability against the RFC vectors.
 */
export function hotpCode(
  secret: Buffer,
  counter: number,
  digits = TOTP_DIGITS,
): string {
  // 8-byte big-endian counter.
  const counterBuf = Buffer.alloc(8);
  // Bigint round-trip avoids the 32-bit silently-truncated multiply
  // that a naive `writeUInt32BE(counter >>> 0, 4)` would produce
  // past the year 2038 (counter overflows 2^31). Authenticators
  // don't run that far ahead but the math should still be correct.
  counterBuf.writeBigUInt64BE(BigInt(counter), 0);

  const hmac = createHmac("sha1", secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binaryCode =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  const mod = 10 ** digits;
  return String(binaryCode % mod).padStart(digits, "0");
}

// ── base32 (RFC 4648 §6) ───────────────────────────────────────────

export function base32Encode(buf: Buffer): string {
  if (buf.length === 0) return "";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  // No padding — authenticator apps accept unpadded base32 and the
  // URI-encoded form is smaller without it.
  return out;
}

export function base32Decode(s: string): Buffer {
  // Strip whitespace + trailing pad characters; upper-case for the
  // lookup. Trailing `=` are stripped via a manual scan rather than
  // `.replace(/=+$/, "")` to avoid quadratic backtracking on
  // adversarial input (CodeQL `js/polynomial-redos`).
  const noSpace = s.replace(/\s+/g, "");
  let end = noSpace.length;
  while (end > 0 && noSpace.charCodeAt(end - 1) === 0x3d /* "=" */) end--;
  const cleaned = noSpace.slice(0, end).toUpperCase();
  if (cleaned.length === 0) return Buffer.alloc(0);

  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) {
      // Invalid character — reject by returning empty so the caller
      // treats it as a verify failure.
      return Buffer.alloc(0);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
