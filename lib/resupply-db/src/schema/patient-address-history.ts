import { sql } from "drizzle-orm";
import {
  index,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { patients } from "./patients";
import { resupplySchema } from "./_schema";

/**
 * patient_address_history — append-only ledger of every shipping-
 * address change for a patient. Surveyors and shipping insurance
 * claims both ask "what address was on file on date X?" — without
 * a history table that's an audit-log dive.
 *
 * Posture
 * -------
 *   * Append-only — no UPDATE / DELETE in normal flow.
 *   * `changed_by_user_id` is the admin who entered the change;
 *     null when the patient self-updated via /account.
 *   * Stores the FULL address snapshot, not a diff. Cheap given
 *     ~1-2 changes per patient per year.
 *
 * No FK column on patients pointing at "current" history row —
 * the live address lives on patients itself; this table is the
 * trail of how it got there.
 */
export const patientAddressHistory = resupplySchema.table(
  "patient_address_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    line1: varchar("line1", { length: 200 }),
    line2: varchar("line2", { length: 200 }),
    city: varchar("city", { length: 120 }),
    state: varchar("state", { length: 64 }),
    postalCode: varchar("postal_code", { length: 32 }),
    country: varchar("country", { length: 2 }),
    /** Free-text reason the CSR typed, or "patient_self_update" /
     *  "csr_correction" / "import" as a stable identifier. */
    reason: varchar("reason", { length: 200 }),
    changedByUserId: text("changed_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    patientIdx: index("patient_address_history_patient_idx").on(t.patientId),
  }),
);

export type PatientAddressHistoryRow =
  typeof patientAddressHistory.$inferSelect;
export type InsertPatientAddressHistoryRow =
  typeof patientAddressHistory.$inferInsert;
