-- 0145_inbound_referral_ai_and_accept — Phase 2 of the inbound
-- referral roadmap.
--
-- Adds:
--   1. AI intent classification on inbound_referral_orders. The
--      Phase 2 dispatcher pass runs Claude over the parsed
--      ParachuteOrder and stores the structured output here so the
--      CSR triage UI can surface it inline. Schema is JSON so we can
--      iterate on the classifier without another migration.
--   2. Match-confidence columns on the patient/provider FK pair the
--      dispatcher already populates in Phase 1.
--   3. The accepted_by_user_id + accepted_at columns the route
--      `POST /admin/inbound-referrals/:id/accept` writes when the CSR
--      promotes the referral into a real patient/order record.
--
-- All new columns are nullable + IF NOT EXISTS — forward-deploy-safe.
-- The accept transition is enforced in the route, not the DB
-- (Postgres lacks conditional NOT NULL), mirroring the inbound_faxes
-- attach pattern.

-- ────────────────────────────────────────────────────────────────────
-- AI classification
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE "resupply"."inbound_referral_orders"
  ADD COLUMN IF NOT EXISTS "ai_classification_json" jsonb;
--> statement-breakpoint

-- Confidence score 0.00–1.00. The classifier sets it; the UI uses it
-- to decide whether to auto-promote `new` → `triaged`. Above 0.85
-- and with a patient + provider match → auto-triaged; otherwise
-- stays `new` for a human.
ALTER TABLE "resupply"."inbound_referral_orders"
  ADD COLUMN IF NOT EXISTS "ai_confidence" numeric(3,2);
--> statement-breakpoint

ALTER TABLE "resupply"."inbound_referral_orders"
  DROP CONSTRAINT IF EXISTS "inbound_referral_orders_ai_confidence_range";
--> statement-breakpoint

ALTER TABLE "resupply"."inbound_referral_orders"
  ADD CONSTRAINT "inbound_referral_orders_ai_confidence_range"
  CHECK ("ai_confidence" IS NULL OR ("ai_confidence" >= 0 AND "ai_confidence" <= 1));
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- Match metadata — captures HOW the matcher reached its conclusion
-- so the CSR has signal without re-running the matcher in their head.
-- ────────────────────────────────────────────────────────────────────

-- 'exact_phone' | 'exact_dob_last_name' | 'fuzzy_phone_tail' |
-- 'none'. Set by match-patient.ts; null until the matcher runs.
ALTER TABLE "resupply"."inbound_referral_orders"
  ADD COLUMN IF NOT EXISTS "patient_match_kind" varchar(40);
--> statement-breakpoint

-- 'exact_npi' | 'nppes_lookup' | 'none'. Set by match-provider.ts.
ALTER TABLE "resupply"."inbound_referral_orders"
  ADD COLUMN IF NOT EXISTS "provider_match_kind" varchar(40);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- Acceptance audit columns
-- ────────────────────────────────────────────────────────────────────
-- accepted_at + accepted_by_user_id already exist (added in 0144);
-- this migration is a no-op for those (kept for documentation). The
-- accept route also stamps the existing accepted_order_id +
-- accepted_order_kind columns.

-- Index: the triage queue page filters by "needs a human" (new +
-- triaged) and groups by AI confidence bucket on its summary stats.
CREATE INDEX IF NOT EXISTS "inbound_referral_orders_ai_confidence_idx"
  ON "resupply"."inbound_referral_orders" ("ai_confidence")
  WHERE "triage_status" IN ('new', 'triaged');
