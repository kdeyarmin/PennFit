import { sql } from "drizzle-orm";
import {
  customType,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { patients } from "./patients";
import { resupplySchema } from "./_schema";

/**
 * phone_lookup — equality-lookup index from a normalized E.164 phone number
 * (HMAC-SHA256, keyed on RESUPPLY_PHONE_HMAC_KEY) to the owning patient.
 *
 * Why this table exists:
 *   `patients.phone_e164` is encrypted with pgcrypto using a random IV (see
 *   ADR 007), so the same plaintext phone number produces a different
 *   ciphertext on every write. That makes equality lookup against the
 *   encrypted column impossible — but inbound SMS webhooks NEED an
 *   equality lookup ("which patient does this `From` number belong to?").
 *
 *   We resolve this by storing a deterministic HMAC of the normalized
 *   E.164 form in a separate row, keyed on a DIFFERENT key
 *   (RESUPPLY_PHONE_HMAC_KEY) from the bulk PHI key (RESUPPLY_DATA_KEY).
 *   A compromise of one key does not unlock the other; an attacker with
 *   the HMAC key alone cannot decrypt patient PHI, and an attacker with
 *   the data key alone cannot rebuild the lookup index.
 *
 *   Stored as `bytea` (raw 32-byte digest, not text) so we can compare
 *   for equality without worrying about encoding drift.
 *
 * Cardinality: one row per patient (patient_id is PK), one row per
 *   phone number (hmac_phone is UNIQUE). Two patients sharing the
 *   same phone number would violate the unique constraint and require
 *   operator triage — which is the right behavior; it surfaces a real
 *   data quality problem instead of silently routing replies to the
 *   wrong patient.
 *
 * No PHI lives on this table (HMAC of phone is not directly reversible
 * without the key, and we store no other patient identifiers here).
 *
 * See ADR 009 for the full threat model.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const phoneLookup = resupplySchema.table(
  "phone_lookup",
  {
    patientId: uuid("patient_id")
      .primaryKey()
      .references(() => patients.id, { onDelete: "cascade" }),
    hmacPhone: bytea("hmac_phone").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    hmacPhoneUnique: uniqueIndex("phone_lookup_hmac_phone_unique").on(
      t.hmacPhone,
    ),
  }),
);

export type PhoneLookupRow = typeof phoneLookup.$inferSelect;
export type InsertPhoneLookupRow = typeof phoneLookup.$inferInsert;
