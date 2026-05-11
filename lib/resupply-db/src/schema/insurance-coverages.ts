import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { patients } from "./patients";
import { resupplySchema } from "./_schema";

/**
 * insurance_coverages — verified payer coverage records for a patient.
 *
 * Why this table exists
 * ---------------------
 * `insurance_leads` captures intake-form submissions before a record
 * is verified. Patients can also have insurance info recorded
 * inline on the order form. Neither stores the benefits
 * investigation result — copay, deductible, in-network status,
 * capped-rental month — that the resupply pipeline needs to gate
 * dispensing.
 *
 * Each row is ONE coverage for ONE patient, ranked primary /
 * secondary / tertiary. A typical patient has 1; a dual-Medicare
 * patient has 2; Medicare + supplement is also 2.
 *
 * Scope: capture only. This Tier-2a sprint adds the schema + the
 * CSR-only admin surface so the verifications team can record the
 * data they already work in spreadsheets today. Tier-2b (Phase 2b
 * in the plan) wires real-time eligibility (Availity / Change
 * Healthcare / Waystar) on top of this same table.
 *
 * PHI posture
 * -----------
 * Insurance details are PHI when tied to a patient — same posture as
 * patient demographics. Member ID, group number, and DOB-of-
 * policyholder are all directly identifying. We treat this row as
 * the same sensitivity bucket as patients itself.
 *
 * Dollar amounts as cents
 * -----------------------
 * Deductible / copay / OOP-max stored as integer cents (never float
 * dollars). Same pattern as shop_orders.amount_total_cents.
 *
 * `capped_rental_status` (Medicare-specific)
 * ------------------------------------------
 * Medicare classifies CPAP devices as a "capped rental" item: rented
 * monthly for the first 13 months, then transferred to the patient.
 * The resupply pipeline cares which month-bucket a patient is in:
 *   * `rental_month_1_to_3` — payer can still cancel before month 4
 *     if the patient fails the 90-day adherence trial.
 *   * `rental_month_4_to_13` — past adherence; rental continues to
 *     month 13.
 *   * `purchased` — month 14+; device is the patient's. Resupply
 *     continues but the machine itself is no longer billable.
 *   * `not_applicable` — non-Medicare commercial purchase, or any
 *     other arrangement.
 */
export const insuranceCoverages = resupplySchema.table(
  "insurance_coverages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),

    rank: text("rank", { enum: ["primary", "secondary", "tertiary"] })
      .notNull()
      .default("primary"),

    // Canonical payer name. Free text up to 120 — same column-shape
    // as `insurance_leads.insurance_carrier`. We don't normalize
    // payer names here (no equivalent of NPPES); a future sprint
    // can add a `payers` lookup table if the search-CRM data shows
    // it's worth the abstraction.
    payerName: varchar("payer_name", { length: 120 }).notNull(),

    planName: varchar("plan_name", { length: 120 }),

    memberId: varchar("member_id", { length: 64 }).notNull(),
    groupNumber: varchar("group_number", { length: 64 }),

    // Subscriber name and relationship to patient (e.g. spouse's
    // policy covers the patient).
    policyholderName: varchar("policyholder_name", { length: 160 }),
    policyholderRelationship: text("policyholder_relationship", {
      enum: ["self", "spouse", "child", "other"],
    }),

    effectiveDate: date("effective_date"),
    terminationDate: date("termination_date"),

    inNetwork: boolean("in_network"),

    // Benefits investigation result. All cents-integer; null when
    // not yet verified or unavailable.
    deductibleCents: integer("deductible_cents"),
    deductibleMetCents: integer("deductible_met_cents"),
    oopMaxCents: integer("oop_max_cents"),
    copayCents: integer("copay_cents"),

    cappedRentalStatus: text("capped_rental_status", {
      enum: [
        "rental_month_1_to_3",
        "rental_month_4_to_13",
        "purchased",
        "not_applicable",
      ],
    }),

    // Timestamp of the most recent verification. Null = never
    // verified (lead-stage capture); set when CSR completes the
    // benefits investigation OR when the Tier-2b automation gets
    // a fresh 271 response.
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedByUserId: uuid("verified_by_user_id"),

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
    patientIdx: index("insurance_coverages_patient_idx").on(t.patientId),
    // Same patient can't have two primary coverages, or two
    // secondaries, etc. Application code can decide whether a
    // re-issued policy from the same payer replaces (UPDATE) or
    // ranks down (new row at lower priority + UPDATE the old one).
    patientRankUnique: uniqueIndex("insurance_coverages_patient_rank").on(
      t.patientId,
      t.rank,
    ),
    deductibleNonNegative: check(
      "insurance_coverages_amounts_non_negative",
      sql`
        (${t.deductibleCents} IS NULL OR ${t.deductibleCents} >= 0) AND
        (${t.deductibleMetCents} IS NULL OR ${t.deductibleMetCents} >= 0) AND
        (${t.oopMaxCents} IS NULL OR ${t.oopMaxCents} >= 0) AND
        (${t.copayCents} IS NULL OR ${t.copayCents} >= 0)
      `,
    ),
  }),
);

export type InsuranceCoverageRow = typeof insuranceCoverages.$inferSelect;
export type InsertInsuranceCoverageRow =
  typeof insuranceCoverages.$inferInsert;
export type InsuranceCoverageRank = NonNullable<
  InsuranceCoverageRow["rank"]
>;
export type CappedRentalStatus = NonNullable<
  InsuranceCoverageRow["cappedRentalStatus"]
>;
