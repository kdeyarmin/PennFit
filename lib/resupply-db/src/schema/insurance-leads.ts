// insurance_leads — durable system of record for submissions to the
// public POST /shop/insurance-leads endpoint (the form on /insurance).
//
// See migration 0030_insurance_leads.sql for the rationale behind
// each column. Short version: the original v1 of this form was
// email-only ("send the team a SendGrid notification and trust the
// inbox"). Persisting the row gives the admin a queue view that
// survives mailbox issues and lets a CSR mark each lead's status
// without touching email.

import { sql } from "drizzle-orm";
import { boolean, index, text, timestamp } from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

/**
 * Lifecycle of a single lead row.
 *
 *   `new`       — just submitted, awaiting CSR triage. Default.
 *   `contacted` — CSR has called/emailed the patient.
 *   `verified`  — insurance is verified; patient handed off to the
 *                 fitting flow or the cash-pay shop.
 *   `closed`    — declined / no-show / duplicate / spam.
 *
 * The set is intentionally small. A future split (e.g. "verified" →
 * "verified-eligible" / "verified-not-eligible") should add new
 * states rather than rename existing ones so historical rows stay
 * readable.
 */
export type InsuranceLeadStatus =
  | "new"
  | "contacted"
  | "verified"
  | "closed";

export const INSURANCE_LEAD_STATUSES: readonly InsuranceLeadStatus[] = [
  "new",
  "contacted",
  "verified",
  "closed",
] as const;

export const insuranceLeads = resupplySchema.table(
  "insurance_leads",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    /** Patient-supplied; trimmed + max 120 chars at the API layer. */
    fullName: text("full_name").notNull(),
    /** Lowercased at submit time by the zod transform. */
    email: text("email").notNull(),
    /** Stored as the user typed it; we do NOT normalize to E.164
     * here because the same lead may legitimately list an extension
     * or a foreign-format number that the CSR will dial as-given. */
    phone: text("phone").notNull(),
    /** Stored as the user typed it (text, not date) — the form
     * accepts both ISO and US-formatted date strings. */
    dateOfBirth: text("date_of_birth").notNull(),
    insuranceCarrier: text("insurance_carrier").notNull(),
    memberId: text("member_id").notNull(),
    /** Optional fields collapse the empty string to null at the API
     * layer so "no value" is a single NULL, not two interchangeable
     * representations. */
    groupNumber: text("group_number"),
    prescribingPhysician: text("prescribing_physician"),
    notes: text("notes"),
    /** See InsuranceLeadStatus jsdoc above. */
    status: text("status").$type<InsuranceLeadStatus>().notNull().default("new"),
    /** Free-text CSR note attached to the row. ≤2000 chars at the
     * API layer. Separate from the patient's `notes` so the two
     * never silently collide. */
    csrNote: text("csr_note"),
    /** SendGrid send results at submission time. Captured so the
     * admin can spot mailbox outages without cross-referencing the
     * SendGrid event log. */
    notificationEmailDelivered: boolean("notification_email_delivered")
      .notNull()
      .default(false),
    confirmationEmailDelivered: boolean("confirmation_email_delivered")
      .notNull()
      .default(false),
    /** Lightweight forensics — submitter IP and UA. Useful for
     * abuse triage; never displayed in the admin UI by default. */
    submitterIp: text("submitter_ip"),
    userAgent: text("user_agent"),
    moderatedAt: timestamp("moderated_at", { withTimezone: true }),
    moderatedBy: text("moderated_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    statusCreatedIdx: index("insurance_leads_status_created_idx").on(
      t.status,
      t.createdAt,
    ),
    emailIdx: index("insurance_leads_email_idx").on(t.email),
  }),
);

export type InsuranceLead = typeof insuranceLeads.$inferSelect;
export type NewInsuranceLead = typeof insuranceLeads.$inferInsert;
