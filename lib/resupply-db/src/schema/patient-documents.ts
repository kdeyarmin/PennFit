import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
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
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),

    /**
     * HIPAA retention horizon (migration 0089). The application
     * computes this at upload time from the document category — see
     * `lib/patient-documents/retention.ts` — so we never lose the
     * "when can we destroy this" answer to a stale config file.
     *
     * Null only for legacy rows pre-dating the migration; a backfill
     * is left to a follow-up since dating those rows correctly
     * requires per-row review (the row's createdAt is the floor,
     * not the answer).
     */
    retentionUntilAt: timestamp("retention_until_at", { withTimezone: true }),

    /**
     * Legal-hold flag. When true, the retention sweep refuses to
     * purge or even flag this row regardless of `retention_until_at`.
     * Surveyors and counsel both ask for this — a litigation hold,
     * a payer audit lookback, or an FDA inquiry can all freeze a
     * document past its normal retention window.
     */
    legalHold: boolean("legal_hold").notNull().default(false),

    /**
     * Stamped when the retention sweep marks the row as eligible
     * for destruction. The admin compliance UI lists these and an
     * admin must explicitly destroy via /admin/patient-documents/
     * :id/destroy — we don't auto-purge bytes. Audit + counsel both
     * want a human step in the destruction path.
     */
    retentionMarkedAt: timestamp("retention_marked_at", { withTimezone: true }),

    /**
     * Stamped when an admin destroys the row's underlying object.
     * The row itself stays (audit trail), but `object_key` is
     * cleared so a future read can't return PHI. The destroy path
     * is /admin/patient-documents/:id/destroy.
     */
    destroyedAt: timestamp("destroyed_at", { withTimezone: true }),
    destroyedByAdminId: text("destroyed_by_admin_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
  },
  (t) => ({
    patientIdx: index("patient_documents_patient_idx").on(t.patientId),
    unreviewedIdx: index("patient_documents_unreviewed_idx")
      .on(t.patientId)
      .where(sql`${t.reviewedAt} IS NULL`),
    // Hot path for the nightly retention sweep: "rows whose
    // retention has passed AND haven't been flagged yet AND aren't
    // on legal hold." Partial index so the worker scan stays cheap
    // even as the table grows.
    retentionSweepIdx: index("patient_documents_retention_sweep_idx")
      .on(t.retentionUntilAt)
      .where(
        sql`${t.retentionMarkedAt} IS NULL AND ${t.destroyedAt} IS NULL AND ${t.legalHold} = false`,
      ),
  }),
);

export type PatientDocumentRow = typeof patientDocuments.$inferSelect;
export type InsertPatientDocumentRow = typeof patientDocuments.$inferInsert;
