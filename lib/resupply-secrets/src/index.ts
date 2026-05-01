// @workspace/resupply-secrets — single-master-key derivation for the
// three resupply secrets (PHI bulk-encryption, link-signing HMAC,
// phone-lookup HMAC).
//
// Why this exists
// ---------------
// Historically the resupply services required three separate Replit
// secrets — RESUPPLY_DATA_KEY, RESUPPLY_LINK_HMAC_KEY,
// RESUPPLY_PHONE_HMAC_KEY — kept distinct so a compromise of one would
// not unlock the others (see ADR 007 and lib/resupply-db/src/phone-hash.ts).
//
// Operationally that's three things to generate, store, rotate, and
// keep in sync across every environment. We can collapse that to a
// single RESUPPLY_MASTER_KEY without giving up the cryptographic
// separation by deriving each subkey via HKDF-SHA256 with a distinct
// `info` label per purpose. HKDF guarantees that learning one derived
// key reveals nothing about the master or the sibling subkeys, so the
// three-key threat model is preserved.
//
// Migration story
// ---------------
// `getXxxKey()` prefers the legacy per-purpose env var when it is set,
// and only derives from RESUPPLY_MASTER_KEY as a fallback. That ordering
// matters: existing deployments with PHI already encrypted under
// RESUPPLY_DATA_KEY (and phone_lookup rows already HMAC'd under
// RESUPPLY_PHONE_HMAC_KEY) keep working unchanged. To move to the
// master-key model, an operator runs the rotation script in
// `lib/resupply-db/scripts/rotate-to-master-key.mjs`, which re-encrypts
// PHI and re-HMACs phone_lookup rows under the derived keys, then drops
// the legacy env vars.
//
// Boundary
// --------
// This module is the ONLY place that reads the three legacy env vars
// or the master env var. Everything else in the workspace must call
// the typed helpers below so the migration story stays in one file.

import { createHmac } from "node:crypto";

export const MASTER_KEY_ENV = "RESUPPLY_MASTER_KEY";
export const DATA_KEY_ENV = "RESUPPLY_DATA_KEY";
export const LINK_HMAC_KEY_ENV = "RESUPPLY_LINK_HMAC_KEY";
export const PHONE_HMAC_KEY_ENV = "RESUPPLY_PHONE_HMAC_KEY";

/**
 * Public list of legacy per-purpose env vars, in the order they appear
 * in the README and rotation docs. Used by env-check helpers.
 */
export const LEGACY_KEY_ENVS = [
  DATA_KEY_ENV,
  LINK_HMAC_KEY_ENV,
  PHONE_HMAC_KEY_ENV,
] as const;

type Purpose = "data" | "link-hmac" | "phone-hmac";

const LEGACY_FOR: Record<Purpose, string> = {
  data: DATA_KEY_ENV,
  "link-hmac": LINK_HMAC_KEY_ENV,
  "phone-hmac": PHONE_HMAC_KEY_ENV,
};

// HKDF salt is a fixed, non-secret domain-separation string. It scopes
// the derivation to this codebase so a master key shared (say) with a
// future sibling system would not produce colliding subkeys.
const HKDF_SALT = Buffer.from("pennfit-resupply-v1", "utf8");

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

function readEnv(name: string, env: EnvLike): string | undefined {
  const v = env[name];
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * HKDF-Extract (RFC 5869): PRK = HMAC-SHA256(salt, IKM).
 */
function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac("sha256", salt).update(ikm).digest();
}

/**
 * HKDF-Expand (RFC 5869) for a single 32-byte output block. Since we
 * only ever ask for 32 bytes (== HashLen for SHA-256) the loop reduces
 * to one HMAC: T(1) = HMAC(PRK, info || 0x01).
 */
function hkdfExpand32(prk: Buffer, info: string): Buffer {
  return createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from(info, "utf8"), Buffer.from([0x01])]))
    .digest();
}

function deriveSubkey(masterKey: string, purpose: Purpose): Buffer {
  const prk = hkdfExtract(HKDF_SALT, Buffer.from(masterKey, "utf8"));
  return hkdfExpand32(prk, `pennfit-resupply/${purpose}`);
}

function missingError(purpose: Purpose): Error {
  const legacy = LEGACY_FOR[purpose];
  return new Error(
    `${legacy} is not set and ${MASTER_KEY_ENV} is not set — refusing to ` +
      `serve resupply secrets for purpose "${purpose}". Set either ` +
      `${MASTER_KEY_ENV} (preferred — one secret derives all three) or ` +
      `the legacy ${legacy} (32+ byte value). See README "Required at boot".`,
  );
}

/**
 * Returns true iff at least one of (master key, the legacy env var for
 * `purpose`) is set. Intended for feature-gate checks, not for use as
 * the actual key.
 *
 * `env` defaults to `process.env`. The override exists so callers in
 * routes/jobs that already accept an `env` parameter can stay
 * hermetic in their unit tests instead of having to mutate
 * `process.env`.
 */
export function hasSecret(purpose: Purpose, env: EnvLike = process.env): boolean {
  return (
    readEnv(MASTER_KEY_ENV, env) !== undefined ||
    readEnv(LEGACY_FOR[purpose], env) !== undefined
  );
}

export function hasDataKey(env: EnvLike = process.env): boolean {
  return hasSecret("data", env);
}

export function hasLinkHmacKey(env: EnvLike = process.env): boolean {
  return hasSecret("link-hmac", env);
}

export function hasPhoneHmacKey(env: EnvLike = process.env): boolean {
  return hasSecret("phone-hmac", env);
}

/**
 * True when the given env has any usable resupply-secret configuration
 * — either the master key or all three legacy keys. Returns false if
 * the config is partially set (e.g. only DATA_KEY but no link/phone),
 * which is the case the boot-time env check rejects.
 */
export function hasFullSecretConfig(env: EnvLike = process.env): boolean {
  if (readEnv(MASTER_KEY_ENV, env) !== undefined) return true;
  return LEGACY_KEY_ENVS.every((name) => readEnv(name, env) !== undefined);
}

/**
 * Returns a descriptive list of secret-config problems suitable for a
 * single boot-time error message. Empty array means OK.
 *
 * Accepts master-only, all-three-legacy, or any combination thereof.
 * Rejects partial legacy config (e.g. data + phone but no link) with a
 * specific error so the operator knows exactly which legacy var is
 * missing.
 */
export function diagnoseSecretConfig(env: EnvLike = process.env): string[] {
  if (readEnv(MASTER_KEY_ENV, env) !== undefined) return [];
  const missing = LEGACY_KEY_ENVS.filter(
    (name) => readEnv(name, env) === undefined,
  );
  if (missing.length === 0) return [];
  if (missing.length === LEGACY_KEY_ENVS.length) {
    return [
      `${MASTER_KEY_ENV} (preferred) is not set, and none of the legacy ` +
        `keys (${LEGACY_KEY_ENVS.join(", ")}) are set either. Set ` +
        `${MASTER_KEY_ENV} to a 32+ byte secret (see README).`,
    ];
  }
  return [
    `${MASTER_KEY_ENV} is not set and the legacy keys are partially ` +
      `configured. Missing: ${missing.join(", ")}. Set ${MASTER_KEY_ENV} ` +
      `to consolidate, or fill in the missing legacy keys.`,
  ];
}

/**
 * pgcrypto data key. Returned as a string passphrase because that's
 * what `pgp_sym_encrypt(plaintext, key)` expects on the SQL side.
 *
 * Legacy `RESUPPLY_DATA_KEY` is returned verbatim so existing
 * pgp_sym_encrypt blobs decrypt without re-encryption. The
 * derived-from-master variant is the hex of the 32-byte HKDF output.
 */
export function getDataKey(env: EnvLike = process.env): string {
  const legacy = readEnv(DATA_KEY_ENV, env);
  if (legacy !== undefined) return legacy;
  const master = readEnv(MASTER_KEY_ENV, env);
  if (master === undefined) throw missingError("data");
  return deriveSubkey(master, "data").toString("hex");
}

/**
 * Link-signing HMAC key. Returned as a Buffer because callers feed it
 * straight to `createHmac("sha256", key)`.
 *
 * Legacy `RESUPPLY_LINK_HMAC_KEY` is returned as the UTF-8 bytes of the
 * env var (matching what the previous code did when it called
 * `createHmac("sha256", process.env.RESUPPLY_LINK_HMAC_KEY)`), so
 * tokens issued under the legacy key still verify after the cutover.
 */
export function getLinkHmacKey(env: EnvLike = process.env): Buffer {
  const legacy = readEnv(LINK_HMAC_KEY_ENV, env);
  if (legacy !== undefined) return Buffer.from(legacy, "utf8");
  const master = readEnv(MASTER_KEY_ENV, env);
  if (master === undefined) throw missingError("link-hmac");
  return deriveSubkey(master, "link-hmac");
}

/**
 * Phone-number-lookup HMAC key. See `getLinkHmacKey` for the shape /
 * compatibility note — phone_lookup.hmac_phone digests issued under the
 * legacy key continue to match after the cutover.
 */
export function getPhoneHmacKey(env: EnvLike = process.env): Buffer {
  const legacy = readEnv(PHONE_HMAC_KEY_ENV, env);
  if (legacy !== undefined) return Buffer.from(legacy, "utf8");
  const master = readEnv(MASTER_KEY_ENV, env);
  if (master === undefined) throw missingError("phone-hmac");
  return deriveSubkey(master, "phone-hmac");
}
