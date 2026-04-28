// @workspace/resupply-db — phone-number HMAC helpers.
//
// Outbound and inbound SMS need to map between an E.164 phone string
// and the row in `phone_lookup` that points to its owning patient. The
// patients.phone_e164 column is encrypted with a random IV, so we
// CAN'T equality-search it; instead we store a deterministic HMAC of
// the normalized phone number in `phone_lookup.hmac_phone` and search
// THAT.
//
// Two safety properties:
//   1. The HMAC key is SEPARATE from the bulk PHI encryption key
//      (RESUPPLY_PHONE_HMAC_KEY vs RESUPPLY_DATA_KEY). Compromise of
//      one does not yield the other.
//   2. The key is read at CALL TIME, not at module load. That keeps
//      every test that does not exercise this code path free of an
//      env-var setup requirement, and surfaces a missing key as a
//      clear runtime error at the lookup site rather than as a
//      mysterious import-time crash.
//
// See ADR 009 for the threat model and operational rotation plan.

import { createHmac } from "node:crypto";

const HMAC_KEY_ENV = "RESUPPLY_PHONE_HMAC_KEY";

function phoneHmacKey(): string {
  const key = process.env[HMAC_KEY_ENV];
  if (!key) {
    throw new Error(
      `${HMAC_KEY_ENV} is not set — refusing to HMAC patient phone numbers. ` +
        "Set it via Replit secrets (32-byte hex; see ADR 009). It must be " +
        "different from RESUPPLY_DATA_KEY so a compromise of one does not " +
        "unlock the other.",
    );
  }
  return key;
}

/**
 * Normalize an arbitrary phone-number string to strict E.164 (`+<digits>`).
 *
 * Accepts:
 *   - Already-E.164 strings: `+12155551212` → `+12155551212`
 *   - 10-digit NANP numbers:  `2155551212`  → `+12155551212`
 *   - 11-digit NANP w/ leading 1: `12155551212` → `+12155551212`
 *   - Punctuation/whitespace: `(215) 555-1212`, `215-555-1212`,
 *     `+1 (215) 555-1212` all normalize to `+12155551212`.
 *
 * Returns `null` for anything that does not parse cleanly. We deliberately
 * do NOT throw — callers (especially the inbound-webhook path) want to
 * branch on "could not normalize" without catching exceptions.
 *
 * E.164 spec: country code + subscriber number, total 8–15 digits after
 * the `+`. We enforce that range; sub-8 is too short to be a real number,
 * super-15 is over-spec.
 *
 * NOTE: We intentionally do NOT validate that the country code is
 * assigned, or that the subscriber number is dialable — that's a
 * carrier-network concern, not a normalization concern. A bogus number
 * will normalize cleanly here, then fail downstream when Twilio refuses
 * to route it. That's the right separation of concerns.
 */
export function normalizeE164(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (hasPlus) {
    if (digits.length < 8 || digits.length > 15) return null;
    return "+" + digits;
  }

  // NANP shortcuts: 10 digits → assume +1; 11 digits with leading 1 → +<digits>.
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;

  return null;
}

/**
 * HMAC a phone number to its lookup-table digest.
 *
 * Throws if the input does not normalize cleanly — callers should
 * normalize first via `normalizeE164` and branch on `null` for the
 * "phone-shaped junk" case. Throws if the key env var is unset.
 *
 * Returns the raw 32-byte digest as a Buffer. Postgres `bytea` is
 * compared byte-wise; do NOT base64/hex this before passing it to
 * Drizzle, or the equality lookup will silently miss every row.
 */
export function hmacPhone(input: string): Buffer {
  const normalized = normalizeE164(input);
  if (!normalized) {
    throw new Error(
      `hmacPhone: input did not normalize to a valid E.164 phone number ` +
        "(got an empty/non-numeric/wrong-length value). Call " +
        "normalizeE164() first and branch on null at the call site.",
    );
  }
  return createHmac("sha256", phoneHmacKey()).update(normalized).digest();
}
