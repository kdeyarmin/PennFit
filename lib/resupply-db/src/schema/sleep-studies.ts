import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { patients } from "./patients";
import { providers } from "./providers";
import { resupplySchema } from "./_schema";

/**
 * sleep_studies — clinical records of overnight sleep studies that
 * diagnose obstructive sleep apnea and justify CPAP therapy.
 *
 * Why this table exists
 * ---------------------
 * Medicare LCD L33718 (and every commercial payer that mirrors it)
 * requires documentation that a patient has been diagnosed with OSA
 * via a qualifying sleep study before approving CPAP coverage. The
 * coverage criteria reference specific numeric findings:
 *
 *   * AHI ≥ 15 OR
 *   * AHI 5-14 with comorbid hypertension, ischemic heart disease,
 *     CVA, insomnia, mood disorder, or excessive daytime sleepiness.
 *
 * Surfacing AHI / RDI / lowest SpO2 as queryable columns (vs. burying
 * them in document_attachment PDFs) lets the system answer
 * "does this patient qualify under LCD L33718?" without a CSR
 * opening every Rx folder.
 *
 * Distinct from `patient_therapy_nights`
 * --------------------------------------
 * therapy_nights = ongoing CPAP usage data (nightly AHI/usage from
 * the device, after therapy starts). sleep_studies = the ONE-TIME
 * diagnostic study, run at a sleep lab or via home sleep apnea
 * testing, performed BEFORE therapy. Different cardinality, different
 * provenance, different downstream consumers. Co-locating them on
 * one table would conflate the diagnostic event with the ongoing
 * monitoring stream — a query mistake we shouldn't bake in.
 *
 * Why not jsonb on patients
 * -------------------------
 * Same reason as providers: queryable columns matter for the
 * compliance gates. A patient may have multiple studies on file
 * (initial diagnosis, re-titration, split-night, follow-up); the
 * coverage decision references the most recent qualifying study by
 * date. That's a `SELECT ... ORDER BY study_date DESC LIMIT 1`
 * away on a normalized row, and a "loop through every patient's
 * jsonb history" job otherwise.
 *
 * PHI posture
 * -----------
 * The numeric findings are PHI when tied to a patient — same posture
 * as patient_therapy_nights. The actual sleep-study PDF stays in
 * App Storage (GCS) under the patient_documents row referenced by
 * `document_id`; we never store the PDF bytes here.
 *
 * `study_type` enum
 * -----------------
 *   * `psg`  — in-lab polysomnography (the gold standard)
 *   * `hsat` — home sleep apnea test (portable monitor)
 *   * `split_night` — diagnostic + titration in one in-lab session
 *   * `re_titration` — repeat in-lab study to adjust pressure
 */
export const sleepStudies = resupplySchema.table(
  "sleep_studies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),

    // The night of the study. Used for "most recent qualifying study"
    // queries and for displaying chronological history on the patient
    // record.
    studyDate: date("study_date").notNull(),

    studyType: text("study_type", {
      enum: ["psg", "hsat", "split_night", "re_titration"],
    }).notNull(),

    // Apnea-Hypopnea Index — events per hour. The single most
    // important number on the study. Range 0-150 captures every
    // plausible value; precision 5/scale 2 gives "29.45" granularity
    // which matches how lab reports are written.
    ahi: numeric("ahi", { precision: 5, scale: 2 }).notNull(),

    // Respiratory Disturbance Index — broader than AHI (includes
    // RERAs). Some payers use RDI for coverage; many don't. Optional.
    rdi: numeric("rdi", { precision: 5, scale: 2 }),

    // Lowest SpO2 (oxygen saturation) observed during the study,
    // as a percentage. Optional — some HSAT devices don't record it.
    lowestSpo2Pct: integer("lowest_spo2_pct"),

    // Sleep efficiency percentage (total sleep time / time in bed).
    // Optional — only PSG/split-night studies measure this.
    sleepEfficiencyPct: integer("sleep_efficiency_pct"),

    // ICD-10 diagnosis the interpreting MD recorded. Free text up
    // to 16 chars (G47.33 etc. — codes can include decimals).
    diagnosisIcd10: varchar("diagnosis_icd10", { length: 16 }),

    // FK to the providers registry — the physician who INTERPRETED
    // the study (not the prescribing physician, though they may be
    // the same person). ON DELETE SET NULL: keeping the study with
    // a null interpreting_provider_id is preferable to losing the
    // diagnostic record entirely.
    interpretingProviderId: uuid("interpreting_provider_id").references(
      () => providers.id,
      { onDelete: "set null" },
    ),

    // Optional link to the sleep-lab facility name. Free text — we
    // don't normalize lab facilities (lower volume than providers,
    // no equivalent of NPPES). Useful on the SWO.
    facilityName: text("facility_name"),

    // Provenance: how this row entered our system.
    //   * `external_lab` — sleep lab faxed/emailed the report.
    //   * `home_test_vendor` — HSAT vendor pushed results (Lofta,
    //     ApneaCheck, etc.).
    //   * `csr_entry` — typed in by a CSR from a faxed PDF.
    source: text("source", {
      enum: ["external_lab", "home_test_vendor", "csr_entry"],
    })
      .notNull()
      .default("csr_entry"),

    // FK into patient_documents row holding the full PDF. Soft —
    // the PDF may not exist if the study came in as a faxed
    // summary the CSR keyed in. Not a hard FK because
    // patient_documents has its own lifecycle (soft-delete via
    // reviewed_at) and we don't want a deleted document row to
    // cascade-delete a clinical record.
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
    patientDateIdx: index("sleep_studies_patient_date_idx").on(
      t.patientId,
      t.studyDate,
    ),
    // Same patient can't legitimately have two studies on the exact
    // same date from the same source — typo guard, not a clinical
    // constraint.
    patientDateSourceUnique: uniqueIndex("sleep_studies_unique").on(
      t.patientId,
      t.studyDate,
      t.source,
    ),
    ahiRangeCheck: check(
      "sleep_studies_ahi_range",
      sql`${t.ahi} >= 0 AND ${t.ahi} <= 150`,
    ),
    spo2RangeCheck: check(
      "sleep_studies_spo2_range",
      sql`${t.lowestSpo2Pct} IS NULL OR (${t.lowestSpo2Pct} >= 0 AND ${t.lowestSpo2Pct} <= 100)`,
    ),
  }),
);

export type SleepStudyRow = typeof sleepStudies.$inferSelect;
export type InsertSleepStudyRow = typeof sleepStudies.$inferInsert;
export type SleepStudyType = NonNullable<SleepStudyRow["studyType"]>;
export type SleepStudySource = NonNullable<SleepStudyRow["source"]>;
