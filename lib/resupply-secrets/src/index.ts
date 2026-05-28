// @workspace/resupply-secrets — single-purpose link-signing key access.
//
// Earlier revisions of this package brokered three secrets (PHI bulk
// encryption, link-signing HMAC, phone-lookup HMAC) and could derive
// them from a single master key via HKDF. Migration 0025 stripped
// pgcrypto column-level encryption and dropped the phone_lookup
// table, so the only remaining secret in this family is the
// link-signing HMAC. The other key paths and the master-key
// derivation flow have been removed; if PHI encryption is ever
// reintroduced, restore them from git history rather than carrying
// dead code.
//
// Boundary
// --------
// This module is the only place in the workspace that reads
// RESUPPLY_LINK_HMAC_KEY. Everything else calls `getLinkHmacKey()`
// or `hasLinkHmacKey()` so the lookup stays in one file.

export const LINK_HMAC_KEY_ENV = "RESUPPLY_LINK_HMAC_KEY";

/**
 * Minimum decoded byte length for the link-signing key. Must stay in
 * lockstep with the preflight check in scripts/preflight-prod-env.ts
 * (`requireBase64Bytes("RESUPPLY_LINK_HMAC_KEY", 32)`); otherwise a
 * key that boots cleanly under preflight could be rejected at runtime
 * or vice-versa.
 */
export const LINK_HMAC_KEY_MIN_BYTES = 32;

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

function readEnv(name: string, env: EnvLike): string | undefined {
  const v = env[name];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * True iff RESUPPLY_LINK_HMAC_KEY is set to a non-empty value.
 * Intended for boot-time env checks and feature gates — never use
 * the boolean as the key itself.
 *
 * `env` defaults to `process.env`; the override exists so unit
 * tests can pass a hermetic env without mutating the global.
 */
export function hasLinkHmacKey(env: EnvLike = process.env): boolean {
  return readEnv(LINK_HMAC_KEY_ENV, env) !== undefined;
}

/**
 * Link-signing HMAC key as raw bytes. Callers feed this straight to
 * `createHmac("sha256", key)`. Throws (rather than returning a
 * sentinel) if the env var is missing — every caller is on a hot
 * path where issuing or verifying an unkeyed token would be a bug,
 * not a degraded mode.
 *
 * The env value is decoded as base64 (matching the preflight check
 * in scripts/preflight-prod-env.ts `requireBase64Bytes(...)`), then
 * verified against `LINK_HMAC_KEY_MIN_BYTES`. Earlier revisions used
 * `Buffer.from(value, "utf8")` which silently produced key material
 * that did not match what preflight had validated.
 */
export function getLinkHmacKey(env: EnvLike = process.env): Buffer {
  const value = readEnv(LINK_HMAC_KEY_ENV, env);
  if (value === undefined) {
    throw new Error(
      `${LINK_HMAC_KEY_ENV} is not set — refusing to sign or verify ` +
        `resupply links. Set ${LINK_HMAC_KEY_ENV} to a base64-encoded ` +
        `secret of at least ${LINK_HMAC_KEY_MIN_BYTES} decoded bytes.`,
    );
  }
  // Mirror requireBase64Bytes(): reject anything outside strict
  // base64 alphabet (Buffer.from silently drops invalid chars, so a
  // URL-safe or hex string would otherwise produce surprising key
  // material).
  if (!/^[A-Za-z0-9+/]+=*$/.test(value)) {
    throw new Error(
      `${LINK_HMAC_KEY_ENV} is not valid base64 ` +
        `(only A-Z, a-z, 0-9, +, /, = padding allowed).`,
    );
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < LINK_HMAC_KEY_MIN_BYTES) {
    throw new Error(
      `${LINK_HMAC_KEY_ENV} decodes to ${decoded.length} bytes; ` +
        `at least ${LINK_HMAC_KEY_MIN_BYTES} bytes are required.`,
    );
  }
  return decoded;
}
