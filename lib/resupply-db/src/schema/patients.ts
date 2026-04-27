import { sql } from "drizzle-orm";
import { index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { encryptedJson, encryptedText } from "../encryption";
import { resupplySchema } from "./_schema";

/**
 * Patients — one row per CPAP patient under management.
 *
 * What's encrypted vs. what's plaintext:
 *   - PHI identifiers (legal name, DOB, phone, email, address) are
 *     pgcrypto-encrypted via `encryptedText` / `encryptedJson`. They live
 *     here, not in `payload`, so we can encrypt them as discrete columns.
 *   - The Pacware-side identifier (`pacwareId`) is the join key the
 *     fulfillment team uses; it is not PHI on its own and stays in
 *     plaintext so it is indexable and searchable.
 *   - `status` and timestamps are operational metadata, not PHI.
 *
 * `pacwareId` is unique because we deduplicate inbound CSVs against it —
 * one row per Pacware patient, ever.
 */
export const patients = resupplySchema.table(
  "patients",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // The Pacware patient ID. Plaintext, indexed, unique. Used to
    // deduplicate CSV imports and to correlate fulfillments back to the
    // legacy DME system.
    pacwareId: text("pacware_id").notNull(),

    // PHI — encrypted at rest with pgcrypto. Use the `encrypt()` /
    // `decrypt()` helpers from `../encryption.ts` at query sites.
    legalFirstName: encryptedText("legal_first_name").notNull(),
    legalLastName: encryptedText("legal_last_name").notNull(),
    dateOfBirth: encryptedText("date_of_birth").notNull(), // YYYY-MM-DD
    phoneE164: encryptedText("phone_e164"),
    email: encryptedText("email"),

    // Mailing address as a single encrypted JSON blob — we never query
    // by sub-fields of the address.
    address: encryptedJson<{
      line1: string;
      line2?: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
    }>("address"),

    // Lifecycle. "active" patients are in scope for outreach; "paused"
    // are temporarily suppressed; "closed" are off the program (moved,
    // declined, deceased — operator-set, see audit_log for the why).
    status: text("status", { enum: ["active", "paused", "closed"] })
      .notNull()
      .default("active"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    pacwareIdUnique: uniqueIndex("patients_pacware_id_unique").on(t.pacwareId),
    statusIdx: index("patients_status_idx").on(t.status),
  }),
);

export type PatientRow = typeof patients.$inferSelect;
export type InsertPatientRow = typeof patients.$inferInsert;
