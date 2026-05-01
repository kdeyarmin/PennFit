import { sql, type SQL } from "drizzle-orm";
import { customType, type PgColumn } from "drizzle-orm/pg-core";

import { getDataKey } from "@workspace/resupply-secrets";

/**
 * PHI encryption — pgcrypto + the resupply data key.
 *
 * See ADR 007 for the full story; the short version:
 *   - Encrypted columns are stored as `bytea` and produced by
 *     `encryptedText(name)` / `encryptedJson(name)` below.
 *   - Writes encrypt with `pgp_sym_encrypt(plaintext, key)` via the
 *     `encrypt()` / `encryptJson()` helpers, which return SQL fragments
 *     callers pass into `db.insert(...).values({ col: encrypt(value) })`.
 *   - Reads decrypt with `pgp_sym_decrypt(col, key)` via `decrypt()` /
 *     `decryptJson()` SQL helpers used inside select projections.
 *
 * The data key itself is sourced from `@workspace/resupply-secrets`
 * which prefers the legacy `RESUPPLY_DATA_KEY` env var (so existing
 * pgp_sym_encrypt blobs decrypt unchanged) and falls back to an
 * HKDF-derived subkey of `RESUPPLY_MASTER_KEY`. See that package for
 * the consolidation rationale and migration path.
 *
 * Why not "transparent" via Drizzle's customType serializers?
 *   Drizzle's `toDriver` / `fromDriver` hooks only return Node values that
 *   become bound parameters — they cannot inject SQL function calls. So a
 *   bytea + helper pair is the most direct way to keep encryption inside
 *   Postgres (which is what pgcrypto is for) while keeping the Drizzle
 *   schema honest about the on-disk shape of each column. Callers do
 *   `decrypt(table.encryptedDob)` exactly the way they would write
 *   `lower(table.email)` — it's a one-line wrapper, not a foot-gun.
 *
 * Direct read/write through the column type itself is intentionally
 * blocked at runtime so that nobody accidentally pipes plaintext PHI
 * through Drizzle without going through the helpers.
 */

const REFUSE_DIRECT_READ = (column: string) =>
  `Refusing to read encrypted column "${column}" through Drizzle's default ` +
  "decoder — wrap the column with decrypt() / decryptJson() in your select " +
  "projection (see lib/resupply-db/src/encryption.ts).";

const REFUSE_DIRECT_WRITE = (column: string) =>
  `Refusing to write encrypted column "${column}" through Drizzle's default ` +
  "encoder — pass encrypt() / encryptJson() as the value (see " +
  "lib/resupply-db/src/encryption.ts).";

/**
 * Declare a PHI text column. Stored as `bytea`. Reads through this column
 * type throw — callers must use `decrypt(col)` in their projection. Writes
 * through this column type throw — callers must use `encrypt(value)` in
 * their `.values({...})` payload.
 */
export const encryptedText = (name: string) =>
  customType<{ data: string; driverData: Buffer }>({
    dataType() {
      return "bytea";
    },
    toDriver(): Buffer {
      throw new Error(REFUSE_DIRECT_WRITE(name));
    },
    fromDriver(): string {
      throw new Error(REFUSE_DIRECT_READ(name));
    },
  })(name);

/**
 * Declare a PHI JSON column. Stored as `bytea` containing the
 * `pgp_sym_encrypt`'d UTF-8 of `JSON.stringify(value)`. Same direct-access
 * guard as `encryptedText`.
 */
export const encryptedJson = <T = unknown>(name: string) =>
  customType<{ data: T; driverData: Buffer }>({
    dataType() {
      return "bytea";
    },
    toDriver(): Buffer {
      throw new Error(REFUSE_DIRECT_WRITE(name));
    },
    fromDriver(): T {
      throw new Error(REFUSE_DIRECT_READ(name));
    },
  })(name);

/**
 * SQL fragment that encrypts a plaintext string for insert/update.
 * `null` and `undefined` round-trip as NULL.
 *
 * Typed as `SQL<string>` (not `SQL<Buffer>`) so it slots into a Drizzle
 * `.values({ ... })` payload for an `encryptedText` column without a
 * cast — Drizzle's insert types derive from the customType's `data` type
 * (string), not from the on-disk `bytea`.
 */
export function encrypt(value: string | null | undefined): SQL<string> {
  if (value == null) {
    return sql`NULL`;
  }
  return sql`pgp_sym_encrypt(${value}::text, ${getDataKey()})`;
}

/**
 * SQL fragment that encrypts an arbitrary JSON-serialisable value. The
 * generic mirrors the column's declared data type so callers don't need
 * to cast at the insert site (e.g.
 * `encryptJson<PatientAddress>(addr)` for `address: encryptedJson<PatientAddress>(...)`).
 */
export function encryptJson<T = unknown>(value: T | null | undefined): SQL<T> {
  if (value == null) {
    return sql`NULL`;
  }
  return sql`pgp_sym_encrypt(${JSON.stringify(value)}::text, ${getDataKey()})`;
}

/**
 * SQL fragment that decrypts an encrypted column back to text. Use it in
 * a select projection: `db.select({ dob: decrypt(patients.dob) }).from(...)`.
 */
export function decrypt(column: PgColumn | SQL): SQL<string | null> {
  return sql<string | null>`pgp_sym_decrypt(${column}, ${getDataKey()})`;
}

/**
 * Same as `decrypt` but parses the result back into a typed object.
 * Wraps the column with `pgp_sym_decrypt(...)::jsonb` so Postgres returns
 * already-parsed JSON instead of a text payload that has to be parsed in
 * Node.
 */
export function decryptJson<T = unknown>(
  column: PgColumn | SQL,
): SQL<T | null> {
  return sql<T | null>`pgp_sym_decrypt(${column}, ${getDataKey()})::jsonb`;
}
