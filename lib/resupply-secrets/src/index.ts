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
 * Provide the link-signing HMAC key as raw UTF-8 bytes suitable for use with `createHmac`.
 *
 * The environment value is treated as raw UTF-8 secret bytes and is deliberately NOT base64-decoded at runtime.
 * Deployment preflight is responsible for base64-decoding the value and enforcing the minimum decoded byte length
 * so runtime decoding is intentionally avoided to preserve existing key material.
 *
 * @param env - Environment object to read the variable from; defaults to `process.env`
 * @returns A `Buffer` containing the environment variable's bytes interpreted as UTF-8
 * @throws Error if `RESUPPLY_LINK_HMAC_KEY` is not set or is an empty string
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
  // Treat the env value as a utf-8 string of secret bytes (matches
  // the original implementation and every signed token in the wild).
  // Preflight (scripts/src/preflight-prod-env.ts) is the deploy-time
  // gate that base64-decodes and enforces >=32 raw bytes — we do
  // NOT mirror that base64 check here because:
  //   (a) it would change the HMAC key material vs every existing
  //       in-flight token, invalidating reminder/portal/Rx links
  //       across the entire deploy at upgrade time;
  //   (b) the docstring length unit ("32+ bytes") referred to the
  //       base64-decoded length, not the utf-8 string length, so a
  //       runtime utf-8 length check would have different semantics
  //       than preflight (as CodeRabbit flagged on PR #409).
  return Buffer.from(value, "utf8");
}

// Consolidated environment aliases — set one PUBLIC_BASE_URL / OPS_EMAIL
// instead of several near-duplicate vars. See ./env-aliases.ts.
export {
  applyEnvAliases,
  PUBLIC_BASE_URL_TARGETS,
  OPS_EMAIL_TARGETS,
} from "./env-aliases";
