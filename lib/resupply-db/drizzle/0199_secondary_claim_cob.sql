-- 0199_secondary_claim_cob — Biller #28: secondary / coordination-of-
-- benefits claims.
--
-- When a patient carries primary + secondary coverage (Medicare + a
-- supplement, commercial + Medicaid), after the PRIMARY payer adjudicates
-- (the 835 posts) the balance it left rolls to the SECONDARY payer on a
-- new 837 carrying the primary's adjudication in the COB (2320/2330)
-- loop. The data model already has `secondary_coverage_id` (0129) and the
-- claim-builder resolves secondary coverage; what's missing is (a) a way
-- to mark a claim's place in the payer sequence and (b) somewhere to
-- SNAPSHOT the primary's adjudication onto the secondary claim so the
-- COB amounts are frozen at generation time (a later primary adjustment
-- must not silently change what we told the secondary).
--
--   * payer_sequence — primary | secondary | tertiary. Every existing
--     claim is a primary (the default), so the backfill is implicit.
--
--   * cob_primary_paid_cents     — what the primary payer PAID (AMT*D).
--   * cob_contractual_cents      — the CO (contractual-obligation)
--                                  adjustment = billed − allowed.
--   * cob_patient_resp_cents     — the PR (patient-responsibility)
--                                  amount the primary assigned.
--     All three NULLABLE — only secondary/tertiary claims carry them;
--     they snapshot the primary's totals at the moment the secondary is
--     generated.
--
-- The secondary claim links back to its primary via the existing
-- `original_claim_number` (0195). Additive, no backfill beyond the
-- payer_sequence default. Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "payer_sequence" text NOT NULL DEFAULT 'primary';
--> statement-breakpoint
-- Soft ref from a secondary/tertiary claim back to its primary (the
-- claim whose 835 left the balance). No FK — SET NULL semantics aren't
-- worth a hard constraint and the primary may be archived independently.
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "primary_claim_id" uuid;
--> statement-breakpoint
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "cob_primary_paid_cents" bigint;
--> statement-breakpoint
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "cob_contractual_cents" bigint;
--> statement-breakpoint
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "cob_patient_resp_cents" bigint;
--> statement-breakpoint

ALTER TABLE "resupply"."insurance_claims"
  DROP CONSTRAINT IF EXISTS "insurance_claims_payer_sequence_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."insurance_claims"
  ADD CONSTRAINT "insurance_claims_payer_sequence_enum"
  CHECK ("payer_sequence" IN ('primary', 'secondary', 'tertiary'));
--> statement-breakpoint

-- The secondary-eligible worklist scans primary claims by sequence.
CREATE INDEX IF NOT EXISTS "insurance_claims_payer_sequence_idx"
  ON "resupply"."insurance_claims" ("payer_sequence");
--> statement-breakpoint
-- "Does this primary already have a secondary?" looks up by primary id.
CREATE INDEX IF NOT EXISTS "insurance_claims_primary_claim_id_idx"
  ON "resupply"."insurance_claims" ("primary_claim_id");
