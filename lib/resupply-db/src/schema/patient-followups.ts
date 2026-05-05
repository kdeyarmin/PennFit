// patient_followups — internal CSR-scheduled callback reminders
// per patient. See migration 0040 for the policy doc; mirrors
// shop_customer_followups but keyed on the patient.
//
// Lifecycle: open (completed_at IS NULL) → completed. No edit /
// delete; revisions are new rows.

import { sql } from "drizzle-orm";
import { index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { patients } from "./patients";
import { resupplySchema } from "./_schema";

export const patientFollowups = resupplySchema.table(
  "patient_followups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),

    body: text("body").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),

    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedByEmail: text("completed_by_email"),
    completedByUserId: text("completed_by_user_id"),

    createdByEmail: text("created_by_email").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    patientDueIdx: index("patient_followups_patient_due_idx").on(
      t.patientId,
      t.dueAt,
    ),
    // The partial "open" index is created by the migration directly
    // (drizzle-kit doesn't express the WHERE clause).
  }),
);

export type PatientFollowupRow = typeof patientFollowups.$inferSelect;
export type InsertPatientFollowupRow = typeof patientFollowups.$inferInsert;
