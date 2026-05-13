import { sql } from "drizzle-orm";
import {
  check,
  index,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { patients } from "./patients";
import { resupplySchema } from "./_schema";

/**
 * patient_identity_verifications — audit trail of patient identity
 * verification events.
 *
 * Why this table exists
 * ---------------------
 * HIPAA, accreditation surveyors, and Medicare's DMEPOS supplier
 * standards all expect a supplier to verify the identity of the
 * patient on the line before disclosing PHI. Today CSRs do this
 * verbally (ask for DOB + last 4 of SSN, or compare against a
 * government ID image upload), but there's no durable record.
 *
 * Posture — never store the actual SSN
 * ------------------------------------
 * We do NOT store the SSN or any other government identifier in
 * this table. The match happens out-of-band (CSR compares what the
 * patient says to what's on the chart or to a verified ID upload);
 * this table records the OUTCOME of that comparison plus the
 * method used, so an auditor can answer "show me when this patient
 * was verified."
 *
 * `method` enum
 * -------------
 *   * `dob_last4_ssn` — CSR asked for DOB + last 4 of SSN over the
 *                       phone and compared against the chart.
 *   * `gov_id_upload` — Patient uploaded a government ID via
 *                       patient_documents; CSR reviewed.
 *   * `video_attest`  — CSR or fitter visually confirmed during a
 *                       telehealth visit.
 *   * `in_person`     — Patient walked into the office and showed
 *                       ID at the counter.
 *
 * `result` enum
 * -------------
 *   * `pass`  — identity verified.
 *   * `fail`  — patient could not satisfy the challenge.
 *   * `skipped` — special-case: patient was previously verified
 *                 within the last 30 days, so we declined to re-
 *                 challenge (recorded so an auditor sees why no
 *                 fresh verification fired this call).
 */
export const patientIdentityVerifications = resupplySchema.table(
  "patient_identity_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),

    method: varchar("method", { length: 32 }).notNull(),
    result: varchar("result", { length: 16 }).notNull(),
    notes: text("notes"),

    verifiedByUserId: text("verified_by_user_id"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    patientIdx: index("patient_identity_verifications_patient_idx").on(
      t.patientId,
    ),
    methodEnum: check(
      "patient_identity_verifications_method_enum",
      sql`${t.method} IN ('dob_last4_ssn','gov_id_upload','video_attest','in_person')`,
    ),
    resultEnum: check(
      "patient_identity_verifications_result_enum",
      sql`${t.result} IN ('pass','fail','skipped')`,
    ),
  }),
);

export type PatientIdentityVerificationRow =
  typeof patientIdentityVerifications.$inferSelect;
export type InsertPatientIdentityVerificationRow =
  typeof patientIdentityVerifications.$inferInsert;
