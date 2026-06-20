-- 0195_claim_adjustment_fields — Biller #32: manual / adjustment claim entry.
--
-- Every claim today originates from a shipped fulfillment. The exception
-- path — keying a CORRECTED, VOID/REPLACEMENT, or paper-backup claim by
-- hand — needs two pieces the schema didn't carry:
--
--   * claim_frequency_code — the X12 837 CLM05-3 / NUCC box-22
--     "resubmission code": 1 = original (default), 7 = replacement of a
--     prior claim, 8 = void/cancel of a prior claim. The 837P builder
--     reads this to populate CLM05-3 instead of hard-coding "1".
--   * original_claim_number — the payer's claim control number (ICN/DCN)
--     of the claim being replaced/voided (837 REF*F8). Required by most
--     payers whenever frequency is 7 or 8; null for an original.
--
-- Plus entry_source so the queue can tell a hand-keyed claim from a
-- fulfillment-derived one (the existing rows are all 'fulfillment').
--
-- Additive, NOT NULL DEFAULT-backfilled (every existing claim becomes
-- frequency '1' / source 'fulfillment' — unchanged behavior). Per
-- ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "claim_frequency_code" text NOT NULL DEFAULT '1';
--> statement-breakpoint
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "original_claim_number" text;
--> statement-breakpoint
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "entry_source" text NOT NULL DEFAULT 'fulfillment';
--> statement-breakpoint

ALTER TABLE "resupply"."insurance_claims"
  DROP CONSTRAINT IF EXISTS "insurance_claims_frequency_code_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."insurance_claims"
  ADD CONSTRAINT "insurance_claims_frequency_code_enum"
  CHECK ("claim_frequency_code" IN ('1', '7', '8'));
--> statement-breakpoint

ALTER TABLE "resupply"."insurance_claims"
  DROP CONSTRAINT IF EXISTS "insurance_claims_entry_source_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."insurance_claims"
  ADD CONSTRAINT "insurance_claims_entry_source_enum"
  CHECK ("entry_source" IN ('fulfillment', 'manual', 'adjustment'));
