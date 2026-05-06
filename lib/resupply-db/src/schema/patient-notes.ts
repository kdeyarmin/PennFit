import { sql } from "drizzle-orm";
import { check, index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { patients } from "./patients";
import { resupplySchema } from "./_schema";

/**
 * Patient notes — free-form, admin-authored, time-stamped notes
 * attached to a patient. The intent is "leave context for the next
 * admin": phone-call summaries, family situation, doctor's office
 * said X, etc.
 *
 * Append-only by design: there is no `updatedAt`, no edit endpoint,
 * and the UI offers no edit affordance. A note is a record of what
 * an admin saw / did at a moment in time — letting one admin rewrite
 * another's note destroys the audit value of the table.
 *
 * `ON DELETE CASCADE`: when a patient row is hard-deleted the notes
 * go with it. The audit log (which is the source of truth for "this
 * patient existed and these admins touched the record") is the
 * long-term record, not this table.
 */
export const patientNotes = resupplySchema.table(
  "patient_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),

    // Free-text note body.
    body: text("body").notNull(),

    // Who wrote it. Denormalized from the auth provider; same rationale as
    // audit_log.adminEmail / adminUserId.
    authorEmail: text("author_email").notNull(),
    authorUserId: text("author_user_id"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    // The dashboard always queries "all notes for this patient,
    // newest first". The composite index lets the (patient_id,
    // created_at desc) order-by be served from the index.
    patientCreatedIdx: index("patient_notes_patient_created_idx").on(
      t.patientId,
      t.createdAt,
    ),
    bodyLength: check(
      "patient_notes_body_max_length",
      sql`length(${t.body}) <= 10000`,
    ),
  }),
);

export type PatientNoteRow = typeof patientNotes.$inferSelect;
export type InsertPatientNoteRow = typeof patientNotes.$inferInsert;
