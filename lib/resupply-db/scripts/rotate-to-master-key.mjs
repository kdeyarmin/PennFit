#!/usr/bin/env node
// Rotate the resupply secrets from the three legacy per-purpose env
// vars onto a single RESUPPLY_MASTER_KEY (HKDF-derived subkeys).
//
// What this does
// --------------
// 1. Re-encrypts every PHI bytea column in the resupply schema:
//    decrypts with the legacy `RESUPPLY_DATA_KEY` and re-encrypts under
//    the HKDF-derived `data` subkey of `RESUPPLY_MASTER_KEY`.
// 2. Re-HMACs every `resupply.phone_lookup.hmac_phone` row using the
//    HKDF-derived `phone-hmac` subkey, sourced from the corresponding
//    patient's freshly-rotated `phone_e164` plaintext.
//
// The link HMAC key (RESUPPLY_LINK_HMAC_KEY) is intentionally NOT
// rotated by this script. Link tokens are stateless and live in
// outbound emails for at most 7 days; a hard cutover would invalidate
// in-flight CTAs. The recommended sequence is:
//   * Set RESUPPLY_MASTER_KEY alongside the existing legacy keys.
//   * Run this script. PHI + phone_lookup are now keyed off MASTER.
//   * Drop RESUPPLY_DATA_KEY and RESUPPLY_PHONE_HMAC_KEY from the
//     environment.
//   * Wait at least 7 days (or whatever your link TTL is), then drop
//     RESUPPLY_LINK_HMAC_KEY. New tokens are signed under the
//     master-derived link key from the moment MASTER is set, because
//     the runtime helper prefers legacy only when it's present.
//
// Safety
// ------
// All updates run inside a single transaction; if anything fails the
// transaction rolls back and the database remains keyed off the
// legacy values. Re-running the script is safe — at the point of
// re-run the legacy data key is still set and PHI is still legible
// under it (because we have not committed yet on a failed run).
// Once committed, attempting to re-run with the legacy var still set
// will produce decryption errors; that's the signal that the
// rotation already succeeded and the operator should remove the
// legacy env vars.
//
// Usage
// -----
//   DATABASE_URL=... \
//   RESUPPLY_DATA_KEY=...           (legacy — current PHI encryption key) \
//   RESUPPLY_PHONE_HMAC_KEY=...     (legacy — current phone HMAC key) \
//   RESUPPLY_MASTER_KEY=...         (new — single source of truth) \
//     node ./scripts/rotate-to-master-key.mjs [--dry-run]
//
// Exit codes:
//   0 — rotation committed (or dry-run completed clean).
//   1 — rotation failed; transaction rolled back. The DB is unchanged.
//   2 — required env var(s) missing.

import { createHmac } from "node:crypto";

import pg from "pg";

const { Pool } = pg;

const HKDF_SALT = Buffer.from("pennfit-resupply-v1", "utf8");

/** HKDF-Extract (RFC 5869): PRK = HMAC-SHA256(salt, IKM). */
function hkdfExtract(salt, ikm) {
  return createHmac("sha256", salt).update(ikm).digest();
}

/** HKDF-Expand for a single 32-byte block. */
function hkdfExpand32(prk, info) {
  return createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from(info, "utf8"), Buffer.from([0x01])]))
    .digest();
}

function deriveSubkey(masterKey, purpose) {
  const prk = hkdfExtract(HKDF_SALT, Buffer.from(masterKey, "utf8"));
  return hkdfExpand32(prk, `pennfit-resupply/${purpose}`);
}

// Inline normalizer that mirrors `lib/resupply-db/src/phone-hash.ts`'s
// `normalizeE164`. Kept inline because this script is `.mjs` and runs
// before the workspace is built (matching the migrate.mjs precedent).
function normalizeE164(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (hasPlus) {
    if (digits.length < 8 || digits.length > 15) return null;
    return "+" + digits;
  }
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return null;
}

// Every encrypted column in the resupply schema. When a new
// encryptedText / encryptedJson column is added to the schema, add it
// here too — the rotation script must see ALL of them or that column
// becomes permanently undecryptable after the legacy key is dropped.
const ENCRYPTED_COLUMNS = [
  { table: "resupply.patients", columns: [
    "legal_first_name",
    "legal_last_name",
    "date_of_birth",
    "phone_e164",
    "email",
    "address",
  ]},
  { table: "resupply.patient_notes", columns: ["body"] },
  { table: "resupply.messages", columns: ["body"] },
  { table: "resupply.prescriptions", columns: ["details"] },
];

function requireEnv(name) {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") {
    process.stderr.write(`[rotate-to-master-key] ${name} is required.\n`);
    process.exit(2);
  }
  return v;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    process.stderr.write("[rotate-to-master-key] DATABASE_URL is required.\n");
    process.exit(2);
  }
  const oldDataKey = requireEnv("RESUPPLY_DATA_KEY");
  const oldPhoneHmac = requireEnv("RESUPPLY_PHONE_HMAC_KEY");
  const masterKey = requireEnv("RESUPPLY_MASTER_KEY");

  const newDataKey = deriveSubkey(masterKey, "data").toString("hex");
  const newPhoneHmac = deriveSubkey(masterKey, "phone-hmac");

  const dryRun = process.argv.includes("--dry-run");

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5_000,
  });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Step 1: re-encrypt every PHI column under the new data key.
    for (const { table, columns } of ENCRYPTED_COLUMNS) {
      for (const col of columns) {
        // Skip nulls; pgp_sym_decrypt(NULL, key) errors on NULL input.
        const sql =
          `UPDATE ${table} SET ${col} = ` +
          `pgp_sym_encrypt(pgp_sym_decrypt(${col}, $1), $2) ` +
          `WHERE ${col} IS NOT NULL`;
        const result = await client.query(sql, [oldDataKey, newDataKey]);
        process.stdout.write(
          `[rotate-to-master-key] ${table}.${col}: re-encrypted ${result.rowCount} row(s)\n`,
        );
      }
    }

    // Step 2: re-HMAC phone_lookup. We have to decrypt (now under the
    // NEW data key, since step 1 already ran inside this txn),
    // normalize in JS, HMAC under the NEW phone key, and write back.
    const lookupRows = await client.query(
      `SELECT pl.patient_id, pgp_sym_decrypt(p.phone_e164, $1) AS phone
         FROM resupply.phone_lookup pl
         JOIN resupply.patients p ON p.id = pl.patient_id
        WHERE p.phone_e164 IS NOT NULL`,
      [newDataKey],
    );
    let rehmacked = 0;
    let skipped = 0;
    for (const row of lookupRows.rows) {
      const normalized = normalizeE164(row.phone);
      if (!normalized) {
        skipped += 1;
        continue;
      }
      const digest = createHmac("sha256", newPhoneHmac)
        .update(normalized)
        .digest();
      // Sanity guard: the runtime check assumes the OLD digest matches
      // the LEGACY HMAC of the current phone. If it doesn't, the row
      // is corrupt or the legacy key passed in doesn't match the one
      // the row was actually written under — abort the txn so we
      // don't silently overwrite legitimate data.
      const expectedOld = createHmac("sha256", Buffer.from(oldPhoneHmac, "utf8"))
        .update(normalized)
        .digest();
      const existing = await client.query(
        `SELECT hmac_phone FROM resupply.phone_lookup WHERE patient_id = $1`,
        [row.patient_id],
      );
      const onDisk = existing.rows[0]?.hmac_phone;
      if (!onDisk || !Buffer.isBuffer(onDisk) || !onDisk.equals(expectedOld)) {
        throw new Error(
          `[rotate-to-master-key] phone_lookup mismatch for patient_id=` +
            `${row.patient_id} — on-disk HMAC does not match the legacy ` +
            `key applied to the (already-rotated) plaintext phone. Aborting ` +
            `transaction. Investigate this row before re-running.`,
        );
      }
      await client.query(
        `UPDATE resupply.phone_lookup SET hmac_phone = $1, updated_at = now() WHERE patient_id = $2`,
        [digest, row.patient_id],
      );
      rehmacked += 1;
    }
    process.stdout.write(
      `[rotate-to-master-key] phone_lookup: re-HMACed ${rehmacked} row(s); skipped ${skipped} row(s) with un-normalizable phones\n`,
    );

    if (dryRun) {
      await client.query("ROLLBACK");
      process.stdout.write(
        "[rotate-to-master-key] DRY RUN — transaction rolled back. No data was modified.\n",
      );
    } else {
      await client.query("COMMIT");
      process.stdout.write(
        "[rotate-to-master-key] Rotation committed.\n" +
          "  Next steps:\n" +
          "    1. Drop RESUPPLY_DATA_KEY and RESUPPLY_PHONE_HMAC_KEY from your secrets store.\n" +
          "    2. Leave RESUPPLY_LINK_HMAC_KEY in place for one full link-token TTL\n" +
          "       (default 7 days), then drop it too.\n" +
          "    3. After step 2, RESUPPLY_MASTER_KEY is the only resupply secret.\n",
      );
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    process.stderr.write(`[rotate-to-master-key] FAILED: ${String(err)}\n`);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  process.stderr.write(`[rotate-to-master-key] unexpected: ${String(err)}\n`);
  process.exit(1);
});
