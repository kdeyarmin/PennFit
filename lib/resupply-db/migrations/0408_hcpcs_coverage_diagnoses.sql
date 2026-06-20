-- 0408_hcpcs_coverage_diagnoses — LCD medical-necessity edit catalog.
--
-- Why this exists
-- ---------------
-- Claim preflight already verifies a diagnosis is *present* (the latest
-- sleep study's ICD-10), but not that the diagnosis actually *supports*
-- the billed HCPCS under the payer's coverage policy. A PAP claim whose
-- diagnosis isn't a covered indication for the code denies for medical
-- necessity — one of the recurring DME denial traps.
--
-- This table is the structured "which ICD-10 codes support this HCPCS"
-- catalog the preflight reads to surface that mismatch BEFORE submit.
--
-- Scope / model
-- -------------
--   * GLOBAL reference data (like resupply.hcpcs_codes / denial_codes),
--     NOT tenant-scoped: the Medicare LCD is national policy. There is
--     intentionally no org_id — rows are read through the service-role
--     client. Per-payer commercial overrides are a documented follow-on
--     (they would carry a nullable payer_profile_id); v1 seeds the
--     Medicare PAP baseline only.
--   * `icd10_code` is stored DOTLESS + uppercase (e.g. 'G4733' for
--     G47.33) and matched as a PREFIX of the (normalised) claim diagnosis,
--     so a category code covers its more-specific children. The evaluator
--     (lib/billing/coverage-diagnosis.ts) normalises both sides the same
--     way.
--   * Additive + fail-soft: a HCPCS with NO rows here yields "no opinion"
--     in the preflight (never a false-positive block); the check is a
--     non-blocking warning.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

-- ---------------------------------------------------------------
-- Coverage-diagnosis catalog.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply"."hcpcs_coverage_diagnoses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- The billable HCPCS this rule covers (e.g. 'E0601'). Not a FK to
  -- hcpcs_codes so a coverage rule can be seeded ahead of / independent
  -- of the entitlement catalog.
  "hcpcs_code" text NOT NULL,
  -- ICD-10-CM code, DOTLESS + uppercase (e.g. 'G4733'). Matched as a
  -- prefix of the normalised claim diagnosis.
  "icd10_code" text NOT NULL,
  "description" text,
  -- Policy citation the rule comes from.
  "policy" text NOT NULL DEFAULT 'LCD L33718',
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "hcpcs_coverage_diagnoses_icd10_format"
    CHECK ("icd10_code" ~ '^[A-Z][0-9A-Z]{1,6}$')
);
--> statement-breakpoint

-- One row per (HCPCS, ICD-10). Idempotent re-seed keys on this.
CREATE UNIQUE INDEX IF NOT EXISTS "hcpcs_coverage_diagnoses_hcpcs_icd10_unique"
  ON "resupply"."hcpcs_coverage_diagnoses" ("hcpcs_code", "icd10_code");
--> statement-breakpoint

-- Hot lookup: "what supports this HCPCS?" — only active rows.
CREATE INDEX IF NOT EXISTS "hcpcs_coverage_diagnoses_hcpcs_idx"
  ON "resupply"."hcpcs_coverage_diagnoses" ("hcpcs_code")
  WHERE "active" = true;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- Seed the Medicare PAP baseline (LCD L33718 / Policy Article A52467).
-- Obstructive sleep apnea (G47.33) is the covered indication for PAP
-- devices and the resupply accessories billed against them. Stored
-- dotless: G47.33 -> G4733. Idempotent via ON CONFLICT on the natural
-- (hcpcs_code, icd10_code) unique index.
-- ---------------------------------------------------------------
INSERT INTO "resupply"."hcpcs_coverage_diagnoses"
  (hcpcs_code, icd10_code, description, policy)
VALUES
  -- PAP devices
  ('E0601', 'G4733', 'Obstructive sleep apnea (adult/pediatric)', 'LCD L33718'),
  ('E0470', 'G4733', 'Obstructive sleep apnea (adult/pediatric)', 'LCD L33718'),
  ('E0471', 'G4733', 'Obstructive sleep apnea (adult/pediatric)', 'LCD L33718'),
  -- Resupply accessories — covered when the PAP device is covered.
  ('A7030', 'G4733', 'Obstructive sleep apnea (adult/pediatric)', 'LCD L33718'),
  ('A7031', 'G4733', 'Obstructive sleep apnea (adult/pediatric)', 'LCD L33718'),
  ('A7032', 'G4733', 'Obstructive sleep apnea (adult/pediatric)', 'LCD L33718'),
  ('A7033', 'G4733', 'Obstructive sleep apnea (adult/pediatric)', 'LCD L33718'),
  ('A7034', 'G4733', 'Obstructive sleep apnea (adult/pediatric)', 'LCD L33718'),
  ('A7035', 'G4733', 'Obstructive sleep apnea (adult/pediatric)', 'LCD L33718'),
  ('A7036', 'G4733', 'Obstructive sleep apnea (adult/pediatric)', 'LCD L33718'),
  ('A7037', 'G4733', 'Obstructive sleep apnea (adult/pediatric)', 'LCD L33718'),
  ('A7038', 'G4733', 'Obstructive sleep apnea (adult/pediatric)', 'LCD L33718'),
  ('A7039', 'G4733', 'Obstructive sleep apnea (adult/pediatric)', 'LCD L33718'),
  ('A7044', 'G4733', 'Obstructive sleep apnea (adult/pediatric)', 'LCD L33718'),
  ('A7046', 'G4733', 'Obstructive sleep apnea (adult/pediatric)', 'LCD L33718'),
  ('A4604', 'G4733', 'Obstructive sleep apnea (adult/pediatric)', 'LCD L33718')
ON CONFLICT ("hcpcs_code", "icd10_code") DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- RLS — deny-all posture (service_role bypasses; 0170/0171 pattern).
-- ---------------------------------------------------------------
ALTER TABLE "resupply"."hcpcs_coverage_diagnoses" ENABLE ROW LEVEL SECURITY;
