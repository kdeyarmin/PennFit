import { sql } from "drizzle-orm";
import { index, integer, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
// Note: reviewed_by_admin_id uses text() because admin_users.id is text, not uuid.

import { adminUsers } from "./admin-users";
import { patients } from "./patients";
import { resupplySchema } from "./_schema";

/**
 * Patient-uploaded documents — insurance cards, prescriptions,
 * referrals, or any other document a patient uploads through their
 * portal for CSR review.
 *
 * `object_key` is a `/objects/uploads/<uuid>` path that the API's
 * ObjectStorageService resolves to a private GCS file. Bytes are NOT
 * stored here — only the metadata needed for list rendering and
 * Content-Disposition on download.
 *
 * `document_type` is a short categorisation string chosen at upload
 * time (e.g. "insurance_card", "prescription", "referral", "other").
 * It drives the label shown in both the patient portal and the CSR
 * view, and is validated server-side against a fixed allowlist.
 *
 * `uploaded_by` is always "patient" — admins attach prescription docs
 * via the prescriptions-attachment route; this table is patient-only.
 */
export const patientDocuments = resupplySchema.table(
  "patient_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),

    /** GCS object path inside PRIVATE_OBJECT_DIR (e.g. /objects/uploads/<uuid>). */
    objectKey: text("object_key").notNull(),

    /** Validated document category chosen by the patient at upload time. */
    documentType: varchar("document_type", { length: 64 }).notNull(),

    /** Best-effort original filename supplied by the browser (not trusted). */
    filename: varchar("filename", { length: 255 }),

    /** Server-validated MIME type at upload time. */
    contentType: varchar("content_type", { length: 120 }).notNull(),

    /** Actual byte count; mirrored from GCS metadata at finalize. */
    sizeBytes: integer("size_bytes").notNull(),

    /** Set when an admin first marks this document as reviewed. Null = not yet seen. */
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),

    /** Which admin user marked the document reviewed; null when not yet reviewed. */
    reviewedByAdminId: text("reviewed_by_admin_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),

    /** Optional free-text note the CSR records when marking reviewed. */
    reviewNote: varchar("review_note", { length: 500 }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    patientIdx: index("patient_documents_patient_idx").on(t.patientId),
    unreviewedIdx: index("patient_documents_unreviewed_idx")
      .on(t.patientId)
      .where(sql`${t.reviewedAt} IS NULL`),
  }),
);

export type PatientDocumentRow = typeof patientDocuments.$inferSelect;
export type InsertPatientDocumentRow = typeof patientDocuments.$inferInsert;
