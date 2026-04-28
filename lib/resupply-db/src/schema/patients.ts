import { sql } from "drizzle-orm";
import {
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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

    // Insurance payer name as free text (e.g. "Aetna", "Medicare",
    // "BCBS-PA"). Not encrypted — payer is sensitive but not PHI on
    // its own, and the global rules engine has to be able to filter
    // on it without round-tripping through pgcrypto. Operator-edited
    // from the dashboard. Nullable: blank means the rules engine
    // treats this patient's insurance as "unknown" and skips any
    // rule that requires a specific payer match.
    insurancePayer: text("insurance_payer"),

    // Per-patient frequency override (in days). When set, this wins
    // over both the matched rule and the prescription's default
    // cadence — see `lib/resupply-domain/src/outreach-plan.ts`.
    // Null means "no override; use the rules engine / prescription
    // default". The rules engine never writes here; only operators do.
    cadenceOverrideDays: integer("cadence_override_days"),

    // Per-patient channel preference. Same precedence as the cadence
    // override — operator-set, wins over rule defaults. Null means
    // "fall back to the matched rule, then to SMS-then-email".
    channelPreference: text("channel_preference", {
      enum: ["sms", "email", "voice"],
    }),

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
