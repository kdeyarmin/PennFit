import { sql } from "drizzle-orm";
import {
  index,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { encryptedText } from "../encryption";
import { patients } from "./patients";
import { resupplySchema } from "./_schema";

/**
 * Patient notes — free-form, admin-authored, time-stamped notes
 * attached to a patient. The intent is "leave context for the next
 * admin": phone-call summaries, family situation, doctor's office
 * said X, etc.
 *
 * What's encrypted vs. plaintext:
 *   - `body` is encrypted because admins WILL paste PHI into the
 *     notes (call summaries quote the patient verbatim, and that
 *     transcript is PHI).
 *   - `authorEmail` and `authorClerkId` are operational metadata,
 *     not PHI. They are denormalized from Clerk so the note remains
 *     attributable if the Clerk user is later deleted (mirrors the
 *     audit log convention).
 *
 * Append-only by design: there is no `updatedAt`, no edit endpoint,
 * and the UI offers no edit affordance. A note is a record of what
 * an admin saw / did at a moment in time — letting one admin rewrite
 * another's note destroys the audit value of the table.
 *
 * `ON DELETE CASCADE`: when a patient row is hard-deleted (PHI purge)
 * the notes go with it. The audit log (which is the source of truth
 * for "this patient existed and these admins touched the record")
 * is the long-term record, not this table.
 */
export const patientNotes = resupplySchema.table(
  "patient_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),

    // Encrypted free text. Use `encrypt()` to write, `decrypt()` to
    // read at query sites — see encryption.ts.
    body: encryptedText("body").notNull(),

    // Who wrote it. Denormalized from Clerk; same rationale as
    // audit_log.adminEmail / adminClerkId.
    authorEmail: text("author_email").notNull(),
    authorClerkId: text("author_clerk_id"),

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
  }),
);

export type PatientNoteRow = typeof patientNotes.$inferSelect;
export type InsertPatientNoteRow = typeof patientNotes.$inferInsert;
