import { sql } from "drizzle-orm";
import {
  check,
  index,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { patients } from "./patients";
import { resupplySchema } from "./_schema";

/**
 * patient_form_acknowledgements — durable e-signature record of a
 * patient accepting a standard intake form.
 *
 * Why this table exists
 * ---------------------
 * Every DMEPOS supplier has to obtain signed copies of:
 *   * HIPAA Notice of Privacy Practices acknowledgement
 *   * Assignment of Benefits (AOB)
 *   * Advance Beneficiary Notice (ABN) — when applicable
 *   * Financial Responsibility / supplier-standards disclosure
 *
 * Today these are paper-and-fax artefacts a CSR scans into
 * patient_documents. The accreditation binder needs an
 * easy-to-prove record that EVERY active patient has signed each
 * required form. A normalized acknowledgements table answers that
 * question with one query; sifting PDF metadata does not.
 *
 * What "signed" means in this row
 * -------------------------------
 * This is a "click-through e-sign" record, not a typed signature
 * with cursive rendering. The legal posture matches HIPAA's
 * "intent to authenticate" standard: an authenticated patient
 * actively clicks "I acknowledge / I agree" on a form whose
 * version is recorded, from an IP we capture, at a timestamp we
 * record. The form text itself is versioned in code (see
 * lib/intake-forms/* once that ships) and reference by
 * `form_version`.
 *
 * Provenance
 * ----------
 *   * `patient_portal` — signed-in patient submitted via /account
 *   * `csr_recorded`   — CSR phoned the patient + recorded the
 *                         verbal acknowledgement
 *   * `paper_scan`     — legacy: CSR uploaded the scanned form;
 *                         signed_at is the date on the paper
 *
 * `form_kind` enum
 * ----------------
 *   * `hipaa_npp` — HIPAA Notice of Privacy Practices
 *   * `aob`       — Assignment of Benefits
 *   * `abn`       — Advance Beneficiary Notice (Medicare)
 *   * `financial_responsibility` — Financial Responsibility &
 *                                  supplier-standards disclosure
 *   * `supplier_standards`        — Standalone supplier-standards
 *                                   acknowledgement (CMS-mandated)
 */
export const patientFormAcknowledgements = resupplySchema.table(
  "patient_form_acknowledgements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),

    formKind: varchar("form_kind", { length: 48 }).notNull(),
    formVersion: varchar("form_version", { length: 24 }).notNull(),

    // ISO-8601 stamp when the patient acknowledged. For paper_scan
    // entries this is the date on the form itself, not when the
    // CSR scanned it.
    signedAt: timestamp("signed_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),

    // IP recorded at click-through. Null for csr_recorded and
    // paper_scan rows. Helps audit "where did this acknowledgement
    // come from" without storing more PII than necessary.
    signedFromIp: varchar("signed_from_ip", { length: 64 }),

    source: text("source", {
      enum: ["patient_portal", "csr_recorded", "paper_scan"],
    })
      .notNull()
      .default("patient_portal"),

    // FK into patient_documents for paper_scan entries — the scanned
    // PDF. Soft (not a constraint) for the same reason as
    // sleep_studies.document_id.
    documentId: uuid("document_id"),

    // Free-text recorded by the CSR for csr_recorded entries (e.g.
    // "called back to confirm name + DOB"). Empty for other sources.
    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    patientIdx: index("patient_form_acks_patient_idx").on(t.patientId),
    formKindEnum: check(
      "patient_form_acks_kind_enum",
      sql`${t.formKind} IN (
        'hipaa_npp', 'aob', 'abn',
        'financial_responsibility', 'supplier_standards'
      )`,
    ),
    // A patient can re-sign the same form on a new version, but we
    // dedupe "same kind, same version, same patient" so a refresh
    // doesn't write a second row.
    patientKindVersionUnique: uniqueIndex(
      "patient_form_acks_patient_kind_version_unique",
    ).on(t.patientId, t.formKind, t.formVersion),
  }),
);

export type PatientFormAcknowledgementRow =
  typeof patientFormAcknowledgements.$inferSelect;
export type InsertPatientFormAcknowledgementRow =
  typeof patientFormAcknowledgements.$inferInsert;
