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
    status: text("status")
      .$type<PhysicianFaxOutreachStatus>()
      .notNull()
      .default("pending"),
    vendorRef: text("vendor_ref"),
    vendorName: text("vendor_name"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    createdByEmail: text("created_by_email").notNull(),
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
    // The partial indexes below live in their respective migrations
    // directly — drizzle-kit can't express the WHERE clause for
    // partial indexes:
    //   0048: vendor_ref partial idx (WHERE vendor_ref IS NOT NULL)
    //   0049: status partial idx (WHERE status = 'pending') for the
    //         ops-status pending-queue COUNT(*) (Phase G.16).
  }),
);

export type PhysicianFaxOutreachRow = typeof physicianFaxOutreach.$inferSelect;
export type InsertPhysicianFaxOutreachRow =
  typeof physicianFaxOutreach.$inferInsert;
