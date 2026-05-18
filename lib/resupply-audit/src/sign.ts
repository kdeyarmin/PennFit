// HMAC-SHA-256 chain signing for resupply.audit_log rows.
//
// Each signed row commits to:
//   * the predecessor's signature (or the empty string for the
//     genesis row), and
//   * a canonical JSON encoding of the row's content + chain_seq.
//
// A verifier replays the chain offline: walk rows in chain_seq
// order, recompute the signature from the previous row's signature
// and the canonical content, and compare. Any in-place mutation or
// dropped row breaks the chain at that point.
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

/**
 * Test seam: provide a key directly instead of reading the env.
 * Pass `null` to clear (afterEach hooks). The application's boot
 * path does NOT call this — it relies on the env var so a
 * misconfigured deploy fails loudly on first audit write.
 */
export function registerAuditHmacKeyForTesting(key: Buffer | null): void {
  registeredKey = key;
}

/**
 * Returns the HMAC key as raw bytes. Looks up the registered test
 * key first, then falls back to decoding `RESUPPLY_AUDIT_HMAC_KEY`
 * as base64. Throws (rather than returning a sentinel) when the
 * env is unset or too short — every caller is on the write path
 * where signing must succeed, and a silent fallback would defeat
 * the §164.312(b) intent of the whole feature.
 */
export function requireAuditHmacKey(): Buffer {
  if (registeredKey !== null) return registeredKey;
  const raw = process.env[AUDIT_HMAC_KEY_ENV]?.trim();
  if (!raw) {
    throw new AuditHmacKeyError(
      `${AUDIT_HMAC_KEY_ENV} is not set — refusing to write unsigned ` +
        `audit rows. Set ${AUDIT_HMAC_KEY_ENV} to a base64-encoded ` +
        `32+ byte secret (generate with: openssl rand -base64 48).`,
    );
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length < MIN_KEY_BYTES) {
    throw new AuditHmacKeyError(
      `${AUDIT_HMAC_KEY_ENV} decoded to ${decoded.length} bytes; ` +
        `at least ${MIN_KEY_BYTES} are required. Generate with: ` +
        `openssl rand -base64 48`,
    );
  }
  return decoded;
}

/**
 * Deterministic JSON encoding: object keys sorted, arrays
 * preserved in order. Required so the signer and any future
 * verifier produce the same bytes for the same content regardless
 * of which JS engine wrote them.
 *
 * Notably: distinct from `JSON.stringify(v)` because that
 * preserves insertion order, which Postgres' jsonb does not.
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
 * Compute one row's signature. `prevSignatureB64` is `null` for the
 * genesis row (chain_seq === 1) and the predecessor's signature
 * everywhere else.
 *
 * The separator byte between prev_signature and canonical content
 * keeps the prev/content boundary unambiguous; without it a
 * crafted prev_signature could be a prefix of canonical content
 * with the same total digest input.
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
