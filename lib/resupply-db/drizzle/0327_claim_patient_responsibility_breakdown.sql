-- 0327_claim_patient_responsibility_breakdown — itemize the patient-
-- responsibility total into deductible / coinsurance / copay.
--
-- insurance_claims.patient_responsibility_cents has always been a single
-- lump sum (CLP04). The 835 already carries the breakdown in its PR-group
-- CAS adjustments by CARC reason code (1=deductible, 2=coinsurance,
-- 3=copay), but the ERA reconciler discarded it. These three columns let
-- the reconciler persist the breakdown so patient statements and the
-- billing portal can show "what is this charge" instead of one opaque
-- balance.
--
-- Informational only: patient_responsibility_cents remains the
-- authoritative open balance the payment/collections paths key off.
-- NOT NULL DEFAULT 0 keeps every existing row valid and lets the
-- reconciler accumulate (existing + delta) the same way it does the total.
--
-- IMPORTANT — journal posture: not listed in _journal.json, matching the
-- established pattern for migrations 0050+.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "deductible_cents" bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "coinsurance_cents" bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "copay_cents" bigint NOT NULL DEFAULT 0;
