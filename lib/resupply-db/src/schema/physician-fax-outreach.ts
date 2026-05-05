// physician_fax_outreach — record of Rx-renewal faxes sent to
// the prescribing physician (Phase G.6 — Phase B.2 follow-up).
// See migration 0048 for the policy doc.

import { sql } from "drizzle-orm";
import { check, index, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { patients } from "./patients";
import { prescriptions } from "./prescriptions";
import { resupplySchema } from "./_schema";

export type PhysicianFaxOutreachStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "failed";

export const PHYSICIAN_FAX_OUTREACH_STATUSES: ReadonlyArray<PhysicianFaxOutreachStatus> =
  ["pending", "sent", "delivered", "failed"];

export const physicianFaxOutreach = resupplySchema.table(
  "physician_fax_outreach",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    prescriptionId: uuid("prescription_id").references(() => prescriptions.id, {
      onDelete: "set null",
    }),
    physicianName: text("physician_name").notNull(),
    physicianFaxE164: text("physician_fax_e164").notNull(),
    coverLetterText: text("cover_letter_text").notNull(),
    status: text("status").notNull().default("pending"),
    vendorRef: text("vendor_ref"),
    vendorName: text("vendor_name"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    createdByEmail: text("created_by_email"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    patientIdx: index("physician_fax_outreach_patient_idx").on(
      t.patientId,
      t.createdAt,
    ),
    statusEnum: check(
      "physician_fax_outreach_status_enum",
      sql`${t.status} IN ('pending','sent','delivered','failed')`,
    ),
    // The partial vendor_ref index (`WHERE vendor_ref IS NOT NULL`)
    // lives in the migration directly — drizzle-kit can't express
    // the WHERE.
    //
    // Migration 0049 also adds a partial pending-status index
    // (`WHERE status = 'pending'`) used by the ops-status feed.
    // Same drizzle-kit-can't-express-WHERE story.
  }),
);

export type PhysicianFaxOutreachRow = typeof physicianFaxOutreach.$inferSelect;
export type InsertPhysicianFaxOutreachRow =
  typeof physicianFaxOutreach.$inferInsert;
