// patient_checkin_attempts — per-(journey, day, channel) attempt
// log for the multi-channel onboarding check-in dispatcher. See
// migration 0065 for the policy doc.
//
// Relationship to `patient_onboarding_journeys`:
//   - The journey row's `dayN_sent_at` records the FIRST successful
//     delivery on any channel (the patient was "reached").
//   - This table records EVERY attempt — successful sends, "patient
//     missing phone" skips, vendor-not-configured skips, and vendor
//     API errors. CSRs use it to diagnose "why didn't this patient
//     hear from us at day 30?" without re-running the dispatcher.
//
// PHI / log posture: structural columns only. We never store the
// rendered message body or the patient's phone/email plaintext here
// — those are read live off the patient row when an attempt fires.

import { sql } from "drizzle-orm";
import { check, index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { patientOnboardingJourneys } from "./patient-onboarding-journeys";
import { patients } from "./patients";
import { resupplySchema } from "./_schema";

export type CheckinAttemptChannel = "email" | "sms" | "voice";
export type CheckinAttemptOutcome =
  | "sent"
  | "skipped_no_contact"
  | "skipped_not_configured"
  | "vendor_error";

export const patientCheckinAttempts = resupplySchema.table(
  "patient_checkin_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    journeyId: uuid("journey_id")
      .notNull()
      .references(() => patientOnboardingJourneys.id, {
        onDelete: "cascade",
      }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    /** day3 | day7 | day30 | day60 | day90. */
    dayLabel: text("day_label").notNull(),
    /** email | sms | voice. */
    channel: text("channel", { enum: ["email", "sms", "voice"] }).notNull(),
    /** sent | skipped_no_contact | skipped_not_configured | vendor_error. */
    outcome: text("outcome", {
      enum: [
        "sent",
        "skipped_no_contact",
        "skipped_not_configured",
        "vendor_error",
      ],
    }).notNull(),
    /** SendGrid messageId / Twilio messageSid / Twilio callSid. */
    vendorRef: text("vendor_ref"),
    /** Bounded short error code, e.g. 'twilio:21610'. */
    errorCode: text("error_code"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    dayLabelEnum: check(
      "patient_checkin_attempts_day_label_enum",
      sql`${t.dayLabel} IN ('day3','day7','day30','day60','day90')`,
    ),
    journeyIdx: index("patient_checkin_attempts_journey_idx").on(
      t.journeyId,
      t.attemptedAt,
    ),
    dedupeIdx: index("patient_checkin_attempts_dedupe_idx").on(
      t.journeyId,
      t.dayLabel,
      t.channel,
      t.outcome,
    ),
  }),
);

export type PatientCheckinAttemptRow =
  typeof patientCheckinAttempts.$inferSelect;
export type InsertPatientCheckinAttemptRow =
  typeof patientCheckinAttempts.$inferInsert;
