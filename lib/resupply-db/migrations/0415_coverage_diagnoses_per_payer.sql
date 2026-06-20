-- 0415_coverage_diagnoses_per_payer — per-payer coverage overrides.
--
-- The medical-necessity edit catalog (migrations 0408/0409) is the NATIONAL
-- (Medicare LCD) baseline. Commercial / Medicare-Advantage plans cover
-- different ICD-10 sets, so this adds an optional per-payer override:
--   * payer_profile_id NULL  → a national default row (as today).
--   * payer_profile_id set   → a tenant payer's own coverage row.
--
-- Resolution (lib/billing/coverage-diagnosis.ts): when the claim's payer has
-- ANY rows for a HCPCS, that set REPLACES the national default for that
-- HCPCS; otherwise the national rows apply. So a payer override is complete
-- per HCPCS, not additive.
--
-- The old single unique index on (hcpcs_code, icd10_code) would block a
-- payer row that duplicates a national (hcpcs, icd10) pair, so it is replaced
-- by two PARTIAL unique indexes — one for the national rows, one per payer.
-- ON DELETE CASCADE removes a payer's overrides if its profile is deleted.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

ALTER TABLE "resupply"."hcpcs_coverage_diagnoses"
  ADD COLUMN IF NOT EXISTS "payer_profile_id" uuid
  REFERENCES "resupply"."payer_profiles"("id") ON DELETE CASCADE;
--> statement-breakpoint

-- Replace the national-only unique index (0408) with side-specific partials.
DROP INDEX IF EXISTS "resupply"."hcpcs_coverage_diagnoses_hcpcs_icd10_unique";
--> statement-breakpoint

-- One national row per (HCPCS, ICD-10).
CREATE UNIQUE INDEX IF NOT EXISTS "hcpcs_coverage_diagnoses_national_unique"
  ON "resupply"."hcpcs_coverage_diagnoses" ("hcpcs_code", "icd10_code")
  WHERE "payer_profile_id" IS NULL;
--> statement-breakpoint

-- One row per (payer, HCPCS, ICD-10).
CREATE UNIQUE INDEX IF NOT EXISTS "hcpcs_coverage_diagnoses_payer_unique"
  ON "resupply"."hcpcs_coverage_diagnoses"
  ("payer_profile_id", "hcpcs_code", "icd10_code")
  WHERE "payer_profile_id" IS NOT NULL;
--> statement-breakpoint

-- Hot lookup for a payer's active overrides on a HCPCS.
CREATE INDEX IF NOT EXISTS "hcpcs_coverage_diagnoses_payer_hcpcs_idx"
  ON "resupply"."hcpcs_coverage_diagnoses" ("payer_profile_id", "hcpcs_code")
  WHERE "active" = true;
