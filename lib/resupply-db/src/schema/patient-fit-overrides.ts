import { sql } from "drizzle-orm";
import { text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { patients } from "./patients";
import { resupplySchema } from "./_schema";

/**
 * patient_fit_overrides — CSR-curated override of the camera-based
 * mask-fitting recommendation for a patient.
 *
 * Why this table exists
 * ---------------------
 * The on-device MediaPipe fit recommender is fast and usually right,
 * but a CSR who has actually seen the patient (or worked their
 * conversation thread) can spot edge cases the camera misses —
 * facial-hair density, prior nasal-mask intolerance, claustrophobia
 * with full-face style. When a CSR decides "this patient really
 * should be on the AirFit P10 Nasal Pillow size M regardless of
 * what the camera said," that override needs to be durable so the
 * next visit to /results doesn't quietly undo their work.
 *
 * Cardinality
 * -----------
 * One override per patient. We treat overrides as the latest CSR
 * judgement; history is in the audit log. PK is patient_id.
 *
 * PHI posture
 * -----------
 * Mask SKU + size + rationale are not PHI on their own, but tied
 * to a patient_id they're patient-care metadata. Same posture as
 * patients.
 */
export const patientFitOverrides = resupplySchema.table(
  "patient_fit_overrides",
  {
    patientId: uuid("patient_id")
      .primaryKey()
      .references(() => patients.id, { onDelete: "cascade" }),

    recommendedMaskSku: varchar("recommended_mask_sku", { length: 64 })
      .notNull(),
    recommendedMaskSize: varchar("recommended_mask_size", { length: 16 }),
    rationale: text("rationale"),

    createdByUserId: text("created_by_user_id"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
);

export type PatientFitOverrideRow = typeof patientFitOverrides.$inferSelect;
export type InsertPatientFitOverrideRow =
  typeof patientFitOverrides.$inferInsert;
