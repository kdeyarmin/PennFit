import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

/**
 * Patients — one row per CPAP patient under management.
 *
 * Storage notes:
 *   - PHI identifiers (legal name, DOB, phone, email, address) are
 *     stored as plain `text` / `jsonb`. Earlier revisions of this
 *     schema kept them pgcrypto-encrypted; migration
 *     0025_strip_phi_encryption decrypted and converted them to
 *     plaintext columns.
 *   - The Pacware-side identifier (`pacwareId`) is the join key the
 *     fulfillment team uses; it is unique because we deduplicate
 *     inbound CSVs against it (one row per Pacware patient, ever).
 *   - `phone_e164` carries a btree index so the inbound-SMS path can
 *     do a direct equality lookup on the From number (this used to
 *     require the now-deleted phone_lookup HMAC table).
 */
export const patients = resupplySchema.table(
  "patients",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // The Pacware patient ID. Indexed, unique. Used to deduplicate
    // CSV imports and to correlate fulfillments back to the legacy
    // DME system.
    pacwareId: text("pacware_id").notNull(),

    legalFirstName: text("legal_first_name").notNull(),
    legalLastName: text("legal_last_name").notNull(),
    dateOfBirth: text("date_of_birth").notNull(), // YYYY-MM-DD
    phoneE164: text("phone_e164"),
    email: text("email"),

    // Mailing address as a single jsonb blob — we never query by
    // sub-fields of the address.
    address: jsonb("address").$type<{
      line1: string;
      line2?: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
    }>(),

    // Lifecycle. "active" patients are in scope for outreach; "paused"
    // are temporarily suppressed; "closed" are off the program (moved,
    // declined, deceased — admin-set, see audit_log for the why).
    status: text("status", { enum: ["active", "paused", "closed"] })
      .notNull()
      .default("active"),

    // Insurance payer name as free text (e.g. "Aetna", "Medicare",
    // "BCBS-PA"). Admin-edited from the dashboard. Nullable: blank
    // means the rules engine treats this patient's insurance as
    // "unknown" and skips any rule that requires a specific payer
    // match.
    insurancePayer: text("insurance_payer"),

    // Per-patient frequency override (in days). When set, this wins
    // over both the matched rule and the prescription's default
    // cadence — see `lib/resupply-domain/src/outreach-plan.ts`.
    // Null means "no override; use the rules engine / prescription
    // default". The rules engine never writes here; only admins do.
    cadenceOverrideDays: integer("cadence_override_days"),

    // Per-patient channel preference. Same precedence as the cadence
    // override — admin-set, wins over rule defaults. Null means
    // "fall back to the matched rule, then to SMS-then-email".
    channelPreference: text("channel_preference", {
      enum: ["sms", "email", "voice"],
    }),

    // Patient portal invite. One auth.users row per patient (soft FK,
    // matching admin_users.auth_user_id pattern). Portal status is
    // computed at query time from portalAuthUserId +
    // auth.users.email_verified_at rather than stored here.
    portalAuthUserId: text("portal_auth_user_id"),
    portalInvitedAt: timestamp("portal_invited_at", { withTimezone: true }),
    portalInvitedBy: text("portal_invited_by"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    pacwareIdUnique: uniqueIndex("patients_pacware_id_unique").on(t.pacwareId),
    statusIdx: index("patients_status_idx").on(t.status),
    phoneE164Idx: index("patients_phone_e164_idx").on(t.phoneE164),
    portalAuthUserIdx: index("patients_portal_auth_user_idx").on(
      t.portalAuthUserId,
    ),
  }),
);

export type PatientRow = typeof patients.$inferSelect;
export type InsertPatientRow = typeof patients.$inferInsert;
