import { sql } from "drizzle-orm";
import {
  date,
  index,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { insuranceCoverages } from "./insurance-coverages";
import { patients } from "./patients";
import { resupplySchema } from "./_schema";

/**
 * prior_authorizations — payer-issued authorizations to dispense a
 * specific HCPCS code for a specific patient under a specific
 * coverage, valid through a specific date.
 *
 * Why this table exists
 * ---------------------
 * Many CPAP-coverage payers (most commercial; some Medicare
 * Advantage; almost no traditional Medicare for the initial machine)
 * require a prior auth (PA) before they'll pay for the equipment.
 * Without a system of record for PAs, the verifications team works
 * them in spreadsheets — which breaks the moment we want to
 * automate dispensing gates ("don't ship until a valid PA covers
 * this HCPCS code through at least the shipping date").
 *
 * Scope: capture only. This Tier-2a sprint records what the
 * verifications team works manually today. Tier-2b wires automated
 * PA submission where the payer supports it (Availity / payer
 * APIs).
 *
 * Status lifecycle
 * ----------------
 *   * `draft` — being assembled; not yet sent. Useful for the
 *     "save and come back to it" CSR flow.
 *   * `submitted` — sent to the payer (fax, portal, API). Awaiting
 *     response.
 *   * `approved` — payer issued an auth number; `approved_through`
 *     stamped with the validity end date.
 *   * `denied` — payer rejected; `denial_reason` captures the
 *     payer-supplied reason code.
 *   * `appealed` — denial under appeal. Subsequent transitions are
 *     approved or denied (final).
 *   * `expired` — `approved_through` has passed. Re-auth needed.
 *
 * PHI posture
 * -----------
 * PAs reference a patient and a specific HCPCS code — same PHI
 * posture as the prescriptions table. The actual payer
 * correspondence (approval letter PDF, denial letter PDF) lives in
 * patient_documents referenced by `document_id`.
 */
export const priorAuthorizations = resupplySchema.table(
  "prior_authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),

    // Optional FK to the specific coverage row this PA was filed
    // under. ON DELETE SET NULL: a closed-out coverage shouldn't
    // delete the PA history.
    insuranceCoverageId: uuid("insurance_coverage_id").references(
      () => insuranceCoverages.id,
      { onDelete: "set null" },
    ),

    // HCPCS code the PA covers (E0601 CPAP device, A7030 full-face
    // cushion, etc.). Same column shape as prescriptions.hcpcs_code.
    hcpcsCode: varchar("hcpcs_code", { length: 12 }).notNull(),

    // Denormalized payer name so an expired-coverage PA still
    // displays its payer in the queue without joining a SET-NULL'd
    // coverage row.
    payerName: varchar("payer_name", { length: 120 }).notNull(),

    // Payer-issued authorization number. Null until status=approved.
    authNumber: varchar("auth_number", { length: 64 }),

    status: text("status", {
      enum: [
        "draft",
        "submitted",
        "approved",
        "denied",
        "appealed",
        "expired",
      ],
    })
      .notNull()
      .default("draft"),

    // Timestamps for each lifecycle transition.
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decisionAt: timestamp("decision_at", { withTimezone: true }),

    // Authorization end date (approved status). Calendar date, not
    // timestamp — payers issue PAs through the end of a calendar day.
    approvedThrough: date("approved_through"),

    denialReason: text("denial_reason"),

    // FK into patient_documents for the approval / denial PDF.
    documentId: uuid("document_id"),

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
    patientIdx: index("prior_authorizations_patient_idx").on(t.patientId),
    // Lookup for "is there a valid PA covering this HCPCS for this
    // patient right now?" — the dispensing gate query.
    patientHcpcsStatusIdx: index(
      "prior_authorizations_patient_hcpcs_status_idx",
    ).on(t.patientId, t.hcpcsCode, t.status),
  }),
);

export type PriorAuthorizationRow = typeof priorAuthorizations.$inferSelect;
export type InsertPriorAuthorizationRow =
  typeof priorAuthorizations.$inferInsert;
export type PriorAuthorizationStatus = NonNullable<
  PriorAuthorizationRow["status"]
>;
