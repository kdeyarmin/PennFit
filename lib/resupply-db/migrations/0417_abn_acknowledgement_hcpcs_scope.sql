-- 0417_abn_acknowledgement_hcpcs_scope — scope a signed ABN to specific items.
--
-- An Advance Beneficiary Notice (CMS-R-131) is signed for a SPECIFIC item the
-- payer is expected to deny — the patient accepts financial liability for
-- THAT item. The modifier engine reads "ABN on file" to flip an
-- expected-non-coverage line from GZ (supplier write-off) to GA (patient
-- liable). Until now that signal was patient-LEVEL: any signed ABN stamped GA
-- on every expected-non-coverage line, even items the patient never signed an
-- ABN for — over-shifting liability.
--
-- This adds an OPTIONAL HCPCS scope to the acknowledgement row:
--   * hcpcs_codes IS NULL (or empty)  → a GENERAL ABN — applies to every line
--     (this is exactly the prior behaviour, so every existing row is
--     unchanged and back-compatible).
--   * hcpcs_codes = '{E0601,A7030}'   → an ITEM-SCOPED ABN — "ABN on file" is
--     true only for those HCPCS; other lines fall back to GZ.
--
-- The column is only meaningful for form_kind = 'abn'; it stays NULL for the
-- other intake forms (HIPAA NPP / AOB / financial responsibility / supplier
-- standards), which have no per-item dimension.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent, additive
-- (nullable column, no backfill, no constraint tightening).

ALTER TABLE "resupply"."patient_form_acknowledgements"
  ADD COLUMN IF NOT EXISTS "hcpcs_codes" text[];
