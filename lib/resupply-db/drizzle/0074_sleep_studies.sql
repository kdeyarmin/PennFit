-- sleep_studies — diagnostic sleep-study records (one-time event per
-- study) that document a patient's OSA diagnosis and justify CPAP
-- therapy under Medicare LCD L33718 + commercial payer mirrors.
-- See lib/resupply-db/src/schema/sleep-studies.ts for the full
-- rationale and PHI posture.
--
-- Distinct from patient_therapy_nights (ongoing usage data) — see
-- the schema comment for why these don't share a table.
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+. Forward-
-- deploy-safe.

CREATE TABLE IF NOT EXISTS "resupply"."sleep_studies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "patient_id" uuid NOT NULL REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "study_date" date NOT NULL,
  "study_type" text NOT NULL,
  "ahi" numeric(5, 2) NOT NULL,
  "rdi" numeric(5, 2),
  "lowest_spo2_pct" integer,
  "sleep_efficiency_pct" integer,
  "diagnosis_icd10" varchar(16),
  "interpreting_provider_id" uuid REFERENCES "resupply"."providers"("id") ON DELETE SET NULL,
  "facility_name" text,
  "source" text NOT NULL DEFAULT 'csr_entry',
  "document_id" uuid,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "sleep_studies_study_type_enum"
    CHECK ("study_type" IN ('psg', 'hsat', 'split_night', 're_titration')),
  CONSTRAINT "sleep_studies_source_enum"
    CHECK ("source" IN ('external_lab', 'home_test_vendor', 'csr_entry')),
  CONSTRAINT "sleep_studies_ahi_range" CHECK ("ahi" >= 0 AND "ahi" <= 150),
  CONSTRAINT "sleep_studies_spo2_range"
    CHECK ("lowest_spo2_pct" IS NULL OR ("lowest_spo2_pct" >= 0 AND "lowest_spo2_pct" <= 100))
);

CREATE INDEX IF NOT EXISTS "sleep_studies_patient_date_idx"
  ON "resupply"."sleep_studies" ("patient_id", "study_date");

CREATE UNIQUE INDEX IF NOT EXISTS "sleep_studies_unique"
  ON "resupply"."sleep_studies" ("patient_id", "study_date", "source");
