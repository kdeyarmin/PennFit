// HMAC-SHA-256 chain signing for resupply.audit_log rows.
//
// Each signed row commits to:
//   * the predecessor's signature, and
//   * a canonical JSON encoding of the row's content + chain_seq.
//
// A verifier replays the chain offline: walk rows in chain_seq
// order, recompute the signature from the previous row's signature
// and the canonical content, and compare. Any in-place mutation or
// dropped row breaks the chain at that point.
//
// Genesis-row contract (verifier-relevant):
//   The genesis row (chain_seq = 1) has `prev_signature = NULL` in
//   the database. The signing function treats `null` and the empty
//   string as the same input — both produce the same HMAC bytes
//   before the inter-field separator. A verifier reading rows from
//   Postgres MUST coerce the SQL NULL to the empty string before
//   feeding it to the HMAC; otherwise the genesis signature won't
//   reproduce. The signer canonicalises this at `signAuditRow`'s
//   first `h.update(...)` call.
//
// Why a separate module and not inlined in index.ts:
//   * The signing function is pure and exhaustively unit-testable
//     without the Supabase client mocked.
//   * The key registration / lookup is small enough to live next to
//     the function it gates so its lifecycle is obvious.
//
// Why base64 strings on the wire:
//   * PostgREST round-trips text losslessly; bytea representation
//     depends on the server's `bytea_output` and varies by driver.
//   * The migration stores `signature` / `prev_signature` as
//     `text`, so we keep the same shape end-to-end.

import { createHmac } from "node:crypto";

export const AUDIT_HMAC_KEY_ENV = "RESUPPLY_AUDIT_HMAC_KEY";

/**
 * Minimum key length (bytes) after base64 decoding. SHA-256 outputs
 * 32 bytes; a key shorter than that would be HMAC-padded but offers
 * less collision resistance, so we reject it at registration time.
 */
const MIN_KEY_BYTES = 32;

/**
 * Distinct error class so `logAuditBestEffort` can re-throw it
 * instead of swallowing as if it were a transient DB failure. A
 * missing or malformed audit HMAC key is a deploy bug — silently
 * skipping audit writes would defeat the §164.312(b) intent.
 */
export class AuditHmacKeyError extends Error {
  override name = "AuditHmacKeyError" as const;
}

let registeredKey: Buffer | null = null;

// Memoized env-derived key. Populated on the first successful decode
// of `RESUPPLY_AUDIT_HMAC_KEY` so subsequent audit writes skip the
// regex + base64 round-trip cost. Cleared when the test override is
// re-registered so suites that mutate the env var don't see stale
// material from a previous run.
let cachedEnvKey: { raw: string; decoded: Buffer } | null = null;

/**
 * Register or clear a test-only HMAC key override used instead of the environment variable.
 *
 * @param key - Buffer containing the raw HMAC key to register for testing, or `null` to clear the override
 */
export function registerAuditHmacKeyForTesting(key: Buffer | null): void {
  registeredKey = key;
  // Wipe the env cache too so a test that subsequently mutates
  // `process.env.RESUPPLY_AUDIT_HMAC_KEY` after calling this clear
  // function sees the new value, not the previously-cached one.
  cachedEnvKey = null;
}

/**
 * Obtain the raw HMAC key used to sign audit-log rows.
 *
 * Prefers a test-registered override when present; otherwise reads the
 * base64-encoded value from the environment variable named by
 * `AUDIT_HMAC_KEY_ENV`, decodes it, and validates its length. The
 * env-derived key is memoized after the first successful decode so
 * the hot audit write path doesn't repeat regex + base64 work on
 * every row.
 *
 * @returns The decoded HMAC key bytes as a `Buffer`.
 * @throws {AuditHmacKeyError} if the environment variable is unset/empty or if the decoded key is shorter than `MIN_KEY_BYTES` bytes.
 */
export function requireAuditHmacKey(): Buffer {
  if (registeredKey !== null) return registeredKey;
  const raw = process.env[AUDIT_HMAC_KEY_ENV]?.trim();
  if (cachedEnvKey !== null && raw === cachedEnvKey.raw) {
    return cachedEnvKey.decoded;
  }
  if (!raw) {
    throw new AuditHmacKeyError(
      `${AUDIT_HMAC_KEY_ENV} is not set — refusing to write unsigned ` +
        `audit rows. Set ${AUDIT_HMAC_KEY_ENV} to a base64-encoded ` +
        `32+ byte secret (generate with: openssl rand -base64 48).`,
    );
  }
  // Buffer.from(raw, "base64") silently drops any character outside
  // the base64 alphabet. A non-base64 string of the right length
  // (e.g. 64 hex chars) would otherwise pass the >= 32 byte check
  // but produce a key that doesn't match what the operator
  // configured, making cross-environment chain verification fail
  // silently. Reject anything that isn't strict base64 OR doesn't
  // round-trip through encode→decode.
  if (!/^[A-Za-z0-9+/]+=*$/.test(raw)) {
    throw new AuditHmacKeyError(
      `${AUDIT_HMAC_KEY_ENV} is not strict base64 (only A-Z, a-z, 0-9, +, /, = padding allowed). Generate with: openssl rand -base64 48`,
    );
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.toString("base64") !== raw) {
    throw new AuditHmacKeyError(
      `${AUDIT_HMAC_KEY_ENV} did not round-trip through base64 decode/encode; the source string is probably not what you think it is. Generate with: openssl rand -base64 48`,
    );
  }
  if (decoded.length < MIN_KEY_BYTES) {
    throw new AuditHmacKeyError(
      `${AUDIT_HMAC_KEY_ENV} decoded to ${decoded.length} bytes; ` +
        `at least ${MIN_KEY_BYTES} are required. Generate with: ` +
        `openssl rand -base64 48`,
    );
  }
  // Memoize after every validation has passed. Only stored once the
  // bytes survive every check, so a future env mutation back to a
  // malformed value still has to re-validate.
  cachedEnvKey = { raw, decoded };
  return decoded;
}

/**
 * Produce a deterministic JSON string with object keys sorted and array order preserved.
 *
 * null and undefined are encoded as `"null"`. Strings, numbers, and booleans use
 * `JSON.stringify`. Arrays are encoded with elements canonicalized in order.
 * Objects are encoded with keys sorted lexicographically and each value canonicalized.
 * The result is a stable JSON text appropriate for signing or cross-engine verification.
 *
 * @returns A canonical JSON text encoding of `value` with stable ordering suitable for signing and verification
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k]))
        .join(",") +
      "}"
    );
  }
  // Unreachable for any JSON-shaped input; keeps tsc happy.
  return JSON.stringify(value);
}

/**
 * The content the application hashes for each row. Chain_seq is
 * included so the signature also commits to the row's position —
 * a row moved to a different slot wouldn't verify even if its
 * payload bytes were identical.
 */
export interface AuditChainContent {
  chain_seq: number;
  operator_email: string | null;
  operator_user_id: string | null;
  action: string;
  target_table: string | null;
  target_id: string | null;
  metadata: unknown;
  ip: string | null;
  user_agent: string | null;
}

/**
 * Produce the base64-encoded HMAC-SHA-256 signature for a single audit-chain row.
 *
 * @param key - Raw HMAC key bytes used to compute the signature
 * @param prevSignatureB64 - Base64-encoded predecessor signature, or `null` for the genesis row
 * @param content - The row content (including `chain_seq`) to be canonically serialized and signed
 * @returns The row signature encoded as a base64 string
 */
export function signAuditRow(
  key: Buffer,
  prevSignatureB64: string | null,
  content: AuditChainContent,
): string {
  const h = createHmac("sha256", key);
  h.update(prevSignatureB64 ?? "");
  h.update("\x00");
  h.update(canonicalJson(content));
  return h.digest("base64");
}
