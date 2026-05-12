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
 * patient_referrals — patient-to-patient word-of-mouth attribution.
 *
 * Why this table exists
 * ---------------------
 * Sleep-apnea diagnosis is high-trust, low-frequency: patients ask
 * other CPAP users for recommendations. A simple "share PennPaps with
 * a friend" link with attribution lets us:
 *   * measure word-of-mouth as a real channel, and
 *   * (optionally, future) issue a thank-you credit to the referrer
 *     once the referee places their first paid order.
 *
 * Each row represents one *invitation* sent (or shareable link
 * minted), not a converted customer. Conversion is detected later by
 * matching `shop_customers.email_lower` (or `shop_orders.customer_
 * email`) against the recorded `referee_email` and writing the
 * `converted_at` timestamp + `converted_order_id`.
 *
 * `referrer_patient_id` is the patient who shared. The schema does
 * NOT require the referee to ever become a patient — most invites
 * lapse without conversion, and that's fine.
 *
 * `code` is the durable short identifier (10 chars, URL-safe) used
 * in the share link. Globally unique so a single click maps to one
 * referrer.
 */
export const patientReferrals = resupplySchema.table(
  "patient_referrals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referrerPatientId: uuid("referrer_patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),

    code: varchar("code", { length: 16 }).notNull(),

    // Optional. Patient enters their friend's email when they
    // generate the link from the portal; null for "shareable link"
    // mode (e.g. shared via SMS or social).
    refereeEmail: varchar("referee_email", { length: 200 }),
    refereeName: varchar("referee_name", { length: 160 }),

    // Conversion attribution. Set by a worker / a Stripe webhook
    // when a paid order is placed by an email matching referee_email
    // (or, in shareable-link mode, when the link itself is the
    // landing path before checkout). Both nullable until conversion.
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    convertedOrderId: uuid("converted_order_id"),

    status: text("status", {
      enum: ["pending", "converted", "expired", "revoked"],
    })
      .notNull()
      .default("pending"),

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
    codeUnique: uniqueIndex("patient_referrals_code_unique").on(t.code),
    referrerIdx: index("patient_referrals_referrer_idx").on(
      t.referrerPatientId,
    ),
    codeFormat: check(
      "patient_referrals_code_format",
      sql`${t.code} ~ '^[A-Za-z0-9_-]{6,16}$'`,
    ),
  }),
);

export type PatientReferralRow = typeof patientReferrals.$inferSelect;
export type InsertPatientReferralRow = typeof patientReferrals.$inferInsert;
