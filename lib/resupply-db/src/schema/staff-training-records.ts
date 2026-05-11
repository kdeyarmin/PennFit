import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  numeric,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { adminUsers } from "./admin-users";
import { resupplySchema } from "./_schema";

/**
 * staff_training_records — per-staff training events the supplier
 * tracks for DMEPOS accreditation (ACHC, BOC, TJC).
 *
 * Why this table exists
 * ---------------------
 * Every DMEPOS supplier accreditation regime asks for:
 *
 *   * Annual HIPAA / Privacy training (Joint Commission DMEPOS std.
 *     PI.01.01.01).
 *   * OSHA bloodborne-pathogens + general safety training (29 CFR
 *     1910.1030).
 *   * Infection-control training for staff who handle returned
 *     equipment.
 *   * Fit-test training where the supplier dispenses respiratory
 *     equipment (CPAP qualifies).
 *   * New-hire orientation completion.
 *
 * Surveyors ask for the EVIDENCE — "show me when Susan last
 * completed HIPAA training and the certificate." Without a
 * queryable record, that turns into a paper-folder hunt during the
 * site visit. This table makes "every staff member, current
 * status, next expiry" a single SELECT.
 *
 * Expiry math
 * -----------
 * Annual trainings have an `expires_at` 365 days after `completed_at`
 * by convention; the table stores the explicit expiry so non-annual
 * trainings (one-time orientation, multi-year licenses) fit the same
 * row shape. The dashboard groups rows into "current / due soon /
 * expired" buckets relative to today; the math lives in a pure
 * helper at lib/compliance/training-expiry.ts so it is testable.
 *
 * PHI posture
 * -----------
 * Staff training is NOT PHI — it's HR/personnel data. Audit
 * metadata can carry the staff email + training type without
 * redaction. Evidence documents (certificate PDFs) live in GCS
 * under the same private ACL as patient_documents.
 *
 * `training_type` enum
 * --------------------
 *   * `hipaa_privacy`           — annual HIPAA Privacy Rule training
 *   * `hipaa_security`          — annual HIPAA Security Rule training
 *   * `osha_bloodborne`         — OSHA bloodborne-pathogens training
 *   * `osha_general`            — general workplace safety
 *   * `infection_control`       — re-processing returned equipment
 *   * `fit_test`                — mask-fitting clinical training
 *   * `new_hire_orientation`    — supplier onboarding
 *   * `dmepos_supplier_stds`    — Medicare 30-standard refresher
 *   * `other`                   — anything not in the above set
 */
export const staffTrainingRecords = resupplySchema.table(
  "staff_training_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),

    trainingType: text("training_type", {
      enum: [
        "hipaa_privacy",
        "hipaa_security",
        "osha_bloodborne",
        "osha_general",
        "infection_control",
        "fit_test",
        "new_hire_orientation",
        "dmepos_supplier_stds",
        "other",
      ],
    }).notNull(),

    /** Free text for the specific course name when the type alone
     *  isn't enough ("HealthStream HIPAA 101 v2026"). */
    courseTitle: varchar("course_title", { length: 200 }),

    /** Date the staff member completed the training (date-only — we
     *  don't need timezone precision here; CSRs enter from a
     *  certificate). */
    completedAt: date("completed_at").notNull(),
    /** Date the training stops counting toward the accreditation
     *  binder. NULL for one-time trainings (orientation). */
    expiresAt: date("expires_at"),

    /** Hours of credit, when the certifying body records it. */
    creditHours: numeric("credit_hours", { precision: 6, scale: 2 }),

    /** Issuing body or training provider — "HealthStream",
     *  "Internal", "OSHA Authorized Trainer", etc. */
    provider: varchar("provider", { length: 120 }),

    /** Certificate identifier when the provider issues one. */
    certificateReference: varchar("certificate_reference", { length: 120 }),

    /** Optional GCS object key for the certificate PDF. Mirrors the
     *  patient_documents pattern; the actual upload happens via a
     *  separate route (not in this Tier-3 sprint). */
    evidenceObjectKey: text("evidence_object_key"),

    /** Free-form notes — context for surveyors. */
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    staffIdx: index("staff_training_records_staff_idx").on(t.staffUserId),
    // Expiry-sweep query: "every training expiring in the next 30
    // days." Index by expiry then type so the dashboard's grouped
    // sort (type → soonest expiry) hits the index.
    expiresTypeIdx: index("staff_training_records_expires_type_idx").on(
      t.expiresAt,
      t.trainingType,
    ),
    expiryAfterCompletion: check(
      "staff_training_records_expiry_after_completion",
      sql`${t.expiresAt} IS NULL OR ${t.expiresAt} >= ${t.completedAt}`,
    ),
  }),
);

export type StaffTrainingRecordRow =
  typeof staffTrainingRecords.$inferSelect;
export type InsertStaffTrainingRecordRow =
  typeof staffTrainingRecords.$inferInsert;
export type StaffTrainingType = NonNullable<
  StaffTrainingRecordRow["trainingType"]
>;
