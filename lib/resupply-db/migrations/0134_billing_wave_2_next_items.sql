-- 0134_billing_wave_2_next_items — Wave 2 of the competitive-gap
-- analysis roadmap (docs/competitive-gap-analysis-2026-05-19.md).
-- All schema for the "Next" + select "Later" buildable items in
-- one migration so the table set lands together:
--
--   1. 270/271 eligibility verification cache         (3.1)
--   2. HETS Same-or-Similar checks                    (3.2)
--   3. Capped-rental lifecycle automation             (3.5)
--   4. CMN/DWO renewal tracking                       (3.6)
--   5. Adherence prediction (heuristic + score history)(5.2)
--   6. Cash-pay membership tier                       (5.6)
--   7. Voice reorder sessions                         (5.7)
--   8. Da Vinci PAS submissions (scaffold)            (4.3)
--
-- The sleep-coach LLM endpoint and FHIR R4 read-only patient
-- endpoint don't require schema additions and ship in the same
-- PR without a migration entry.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ────────────────────────────────────────────────────────────────────
-- 1. eligibility_checks — 270/271 round-trip cache.
-- ────────────────────────────────────────────────────────────────────
--
-- One row per X12 270 we send. The 271 response lands here too
-- (parsed_response_json) once the inbound poller dispatches it.
-- The "active" cache view is the most recent successful check per
-- (insurance_coverage_id) within the cache_ttl window (default 24h);
-- the claim builder reads from that view to avoid double-billing the
-- payer for the same eligibility lookup.
CREATE TABLE IF NOT EXISTS "resupply"."eligibility_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "insurance_coverage_id" uuid NOT NULL
    REFERENCES "resupply"."insurance_coverages"("id") ON DELETE CASCADE,
  -- Snapshot of the patient + payer the request was built for. We
  -- keep these as denormalised text so the audit trail survives a
  -- coverage edit.
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "payer_profile_id" uuid
    REFERENCES "resupply"."payer_profiles"("id") ON DELETE SET NULL,
  -- HCPCS the 270 was scoped to (Office Ally requires a service-type
  -- code; we map HCPCS → STC code in the builder).
  "service_hcpcs" varchar(12),
  -- The X12 control numbers + file name we used on the outbound 270.
  "isa_control_number" varchar(9),
  "gs_control_number" varchar(9),
  "outbound_file_name" varchar(160),
  -- Status walk: queued → submitted → parsed | rejected | transport_failed
  "status" text NOT NULL DEFAULT 'queued',
  -- Active coverage flag from EB segments in the 271.
  "is_active" boolean,
  "in_network" boolean,
  -- Money in cents; null when the payer didn't report the field.
  "deductible_cents" bigint,
  "deductible_met_cents" bigint,
  "oop_max_cents" bigint,
  "oop_met_cents" bigint,
  "copay_cents" bigint,
  "coinsurance_pct" smallint,
  -- True when the 271 indicates this service requires prior
  -- authorization for the patient.
  "requires_prior_auth" boolean,
  -- Raw parsed structured 271 for the CSR UI ("show me the full
  -- coverage detail"). We never persist the raw payload — only the
  -- parsed view.
  "parsed_response_json" jsonb,
  -- Free-form rejection reason on rejected/transport_failed.
  "error_message" text,
  "requested_at" timestamp with time zone NOT NULL DEFAULT now(),
  "responded_at" timestamp with time zone,
  "requested_by_email" varchar(180) NOT NULL,
  CONSTRAINT "eligibility_checks_status_enum"
    CHECK ("status" IN (
      'queued', 'submitted', 'parsed', 'rejected', 'transport_failed'
    )),
  CONSTRAINT "eligibility_checks_coinsurance_range"
    CHECK ("coinsurance_pct" IS NULL OR ("coinsurance_pct" >= 0 AND "coinsurance_pct" <= 100))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "eligibility_checks_coverage_idx"
  ON "resupply"."eligibility_checks" ("insurance_coverage_id", "requested_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "eligibility_checks_patient_idx"
  ON "resupply"."eligibility_checks" ("patient_id", "requested_at" DESC);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 2. medicare_same_or_similar_checks — HETS 270 cache for the
--    "did Medicare pay another supplier for this HCPCS in the last
--    5 years for this patient?" lookup.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."medicare_same_or_similar_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "hcpcs_code" varchar(12) NOT NULL,
  -- The most-recent prior-supplier dispense date HETS returned, or
  -- null when none.
  "last_dispense_on" date,
  -- "active" = HETS says another supplier is currently in the rental
  -- cycle for this HCPCS; "inactive" = a prior dispense exists but
  -- ownership transferred or rental ended; "clear" = no prior
  -- dispense in 5-year window.
  "status" text NOT NULL,
  "raw_response_json" jsonb,
  "checked_at" timestamp with time zone NOT NULL DEFAULT now(),
  "requested_by_email" varchar(180) NOT NULL,
  CONSTRAINT "same_or_similar_status_enum"
    CHECK ("status" IN ('clear', 'inactive', 'active', 'unknown'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "same_or_similar_patient_hcpcs_idx"
  ON "resupply"."medicare_same_or_similar_checks"
  ("patient_id", "hcpcs_code", "checked_at" DESC);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 3. capped_rental_cycles — Medicare capped-rental lifecycle.
-- ────────────────────────────────────────────────────────────────────
--
-- One row per (patient, HCPCS, rental start). Tracks months 1..13
-- automatically: the worker advances current_month on the
-- (start_date + N * 30 days) anniversary, applies the right modifier
-- rotation (KH for 1-3, KI for 4-13 with KX when compliant), and
-- emits a draft claim via the claim builder.
CREATE TABLE IF NOT EXISTS "resupply"."capped_rental_cycles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "hcpcs_code" varchar(12) NOT NULL,
  "payer_profile_id" uuid
    REFERENCES "resupply"."payer_profiles"("id") ON DELETE SET NULL,
  "insurance_coverage_id" uuid
    REFERENCES "resupply"."insurance_coverages"("id") ON DELETE SET NULL,
  -- Date of service for month 1 — drives the monthly anniversary.
  "start_date" date NOT NULL,
  "current_month" smallint NOT NULL DEFAULT 1,
  "max_months" smallint NOT NULL DEFAULT 13,
  -- True once the patient owns the device outright (post month 13
  -- ownership transfer for CPAP / RAD; post month 36 for oxygen).
  "ownership_transferred_on" date,
  "status" text NOT NULL DEFAULT 'active',
  -- The most-recent insurance_claims row generated by the worker;
  -- lets the UI link "see this month's claim" without a join.
  "latest_claim_id" uuid
    REFERENCES "resupply"."insurance_claims"("id") ON DELETE SET NULL,
  -- Free-form ops notes (mid-cycle plan change, hospitalization break,
  -- patient declines, etc).
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "capped_rental_cycles_status_enum"
    CHECK ("status" IN ('active', 'paused', 'transferred', 'cancelled')),
  CONSTRAINT "capped_rental_cycles_month_range"
    CHECK ("current_month" >= 1 AND "current_month" <= 36),
  CONSTRAINT "capped_rental_cycles_max_months_range"
    CHECK ("max_months" IN (13, 15, 36))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "capped_rental_cycles_active_idx"
  ON "resupply"."capped_rental_cycles" ("status", "start_date")
  WHERE "status" = 'active';
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "capped_rental_cycles_patient_hcpcs_active_uq"
  ON "resupply"."capped_rental_cycles" ("patient_id", "hcpcs_code")
  WHERE "status" IN ('active', 'paused');
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 4. dwo_documents — DWO / CMN renewal tracking.
-- ────────────────────────────────────────────────────────────────────
--
-- DMEPOS Written Orders (DWO) replaced the legacy CMN for most HCPCS
-- in 2020; oxygen still uses the CMN-484. Both need renewal at
-- defined intervals. The cron job (worker/jobs/dwo-renewal-sweep.ts)
-- alerts CSRs at T-60 / T-30 / T-7 days before expiry.
CREATE TABLE IF NOT EXISTS "resupply"."dwo_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "hcpcs_family" text NOT NULL,
  "form_type" text NOT NULL,
  "signing_provider_id" uuid
    REFERENCES "resupply"."providers"("id") ON DELETE SET NULL,
  "signed_on" date NOT NULL,
  "expires_on" date NOT NULL,
  -- Object storage key for the rendered/signed PDF.
  "document_object_key" text,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "dwo_documents_family_enum"
    CHECK ("hcpcs_family" IN ('pap', 'rad', 'oxygen', 'hospital_bed', 'wheelchair', 'other')),
  CONSTRAINT "dwo_documents_form_type_enum"
    CHECK ("form_type" IN ('dwo', 'cmn_484', 'cmn_843', 'swo')),
  CONSTRAINT "dwo_documents_dates_ordered"
    CHECK ("expires_on" >= "signed_on")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "dwo_documents_patient_idx"
  ON "resupply"."dwo_documents" ("patient_id", "expires_on" DESC);
--> statement-breakpoint

-- NOTE: originally a partial index with `WHERE expires_on >= CURRENT_DATE`,
-- but CURRENT_DATE is only STABLE (not IMMUTABLE) and Postgres rejects
-- non-IMMUTABLE functions in an index predicate ("functions in index
-- predicate must be marked IMMUTABLE"), so that form never builds on a
-- fresh database. A plain B-tree on expires_on serves the same
-- "expiring soon" range scan; the predicate was only a size trim.
CREATE INDEX IF NOT EXISTS "dwo_documents_expiring_idx"
  ON "resupply"."dwo_documents" ("expires_on");
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 5. adherence_predictions — heuristic-then-ML adherence score history.
-- ────────────────────────────────────────────────────────────────────
--
-- Phase 1 ships a heuristic scorer (lib/clinical/adherence-predictor.ts)
-- that produces a 0..1 P(90-day compliance) using week-1 usage data,
-- mask type, and demographic factors. Phase 2 swaps in an XGBoost
-- model trained on accumulated patient_therapy_nights history.
--
-- We persist every score so a future model can be back-tested against
-- the actual outcomes.
CREATE TABLE IF NOT EXISTS "resupply"."adherence_predictions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "model_version" varchar(20) NOT NULL,
  -- Days-of-therapy at scoring time (driving feature for the
  -- heuristic; lets us bucket scores by "week 1 vs week 4" later).
  "days_of_therapy" integer NOT NULL,
  -- P(meets 90-day CMS compliance); 0..1.
  "probability_compliant" real NOT NULL,
  -- Structured factor list: [{key, weight, label}].
  "factors_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Outcome stamped by a future reconciliation job: did the patient
  -- actually meet 90-day compliance? Null = not yet observed.
  "actual_compliant" boolean,
  "outcome_observed_at" timestamp with time zone,
  "scored_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "adherence_predictions_probability_range"
    CHECK ("probability_compliant" >= 0 AND "probability_compliant" <= 1)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "adherence_predictions_patient_idx"
  ON "resupply"."adherence_predictions" ("patient_id", "scored_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "adherence_predictions_at_risk_idx"
  ON "resupply"."adherence_predictions" ("probability_compliant", "scored_at" DESC)
  WHERE "probability_compliant" < 0.5;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 6. ALTER shop_customers — cash-pay membership tier.
-- ────────────────────────────────────────────────────────────────────
--
-- Lofta WorryFree / SoClean Easy Pay reference pattern: a paid
-- monthly/quarterly tier that unlocks free shipping + included
-- Rx renewal + concierge access. Stripe Subscriptions handles
-- billing; this column just routes feature unlocks.
ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "membership_tier" text,
  ADD COLUMN IF NOT EXISTS "membership_started_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "membership_renews_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "membership_stripe_subscription_id" varchar(80);
--> statement-breakpoint

ALTER TABLE "resupply"."shop_customers"
  DROP CONSTRAINT IF EXISTS "shop_customers_membership_tier_enum";
--> statement-breakpoint

ALTER TABLE "resupply"."shop_customers"
  ADD CONSTRAINT "shop_customers_membership_tier_enum"
    CHECK (
      "membership_tier" IS NULL
      OR "membership_tier" IN ('payg', 'monthly_unlimited', 'quarterly_unlimited')
    );
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "shop_customers_membership_active_idx"
  ON "resupply"."shop_customers" ("membership_tier", "membership_renews_at")
  WHERE "membership_tier" IS NOT NULL
        AND "membership_tier" <> 'payg';
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 7. voice_reorder_sessions — AI inbound IVR sessions.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."voice_reorder_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "twilio_call_sid" varchar(80) NOT NULL UNIQUE,
  "from_e164" varchar(20) NOT NULL,
  -- Resolved patient when the IVR identification step succeeds.
  -- Null when the caller could not be identified.
  "patient_id" uuid
    REFERENCES "resupply"."patients"("id") ON DELETE SET NULL,
  "shop_customer_id" uuid,
  "status" text NOT NULL DEFAULT 'in_progress',
  -- Structured outcome JSON: items ordered, identification path, etc.
  "outcome_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "ended_at" timestamp with time zone,
  -- The internal order id created at the end of a successful session.
  "shop_order_id" uuid,
  CONSTRAINT "voice_reorder_sessions_status_enum"
    CHECK ("status" IN (
      'in_progress',
      'completed_order',
      'completed_no_order',
      'patient_not_identified',
      'transferred_to_human',
      'failed'
    ))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "voice_reorder_sessions_patient_idx"
  ON "resupply"."voice_reorder_sessions" ("patient_id", "started_at" DESC)
  WHERE "patient_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "voice_reorder_sessions_status_idx"
  ON "resupply"."voice_reorder_sessions" ("status", "started_at" DESC);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 8. davinci_pas_submissions — FHIR-based prior-auth submissions.
-- ────────────────────────────────────────────────────────────────────
--
-- CMS-0057-F requires payers to implement the Da Vinci PAS bundle
-- (CRD → DTR → PAS). Standard PA decisions in Medicaid managed
-- care must complete within 7 calendar days starting 2026-01-01.
--
-- This table is the audit trail of FHIR Claim resources we send to
-- payer PAS endpoints, separate from the X12 PA flow tracked in
-- prior_authorizations. A single resupply.prior_authorizations row
-- may have 0..1 davinci_pas_submissions rows depending on whether
-- the payer accepts FHIR PAS.
CREATE TABLE IF NOT EXISTS "resupply"."davinci_pas_submissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "prior_authorization_id" uuid NOT NULL
    REFERENCES "resupply"."prior_authorizations"("id") ON DELETE CASCADE,
  -- The payer's FHIR PAS endpoint base URL.
  "payer_pas_endpoint" text NOT NULL,
  -- FHIR Bundle.id we sent.
  "bundle_id" varchar(120) NOT NULL,
  -- The FHIR Claim.identifier value (our handle for the PA request).
  "claim_identifier" varchar(120) NOT NULL,
  -- HTTP transport status — driven by the FHIR client, not the
  -- payer's PA disposition.
  "transport_status" text NOT NULL DEFAULT 'queued',
  -- Payer-side PA disposition (parsed from the ClaimResponse).
  "decision" text,
  "auth_number" varchar(64),
  "decision_at" timestamp with time zone,
  "denial_reason" text,
  -- Round-trip latency for ops cost tracking.
  "latency_ms" integer,
  "error_message" text,
  "requested_at" timestamp with time zone NOT NULL DEFAULT now(),
  "responded_at" timestamp with time zone,
  "submitted_by_email" varchar(180) NOT NULL,
  CONSTRAINT "davinci_pas_submissions_transport_status_enum"
    CHECK ("transport_status" IN (
      'queued', 'submitted', 'responded', 'rejected', 'transport_failed'
    )),
  CONSTRAINT "davinci_pas_submissions_decision_enum"
    CHECK (
      "decision" IS NULL
      OR "decision" IN ('approved', 'denied', 'pended', 'cancelled')
    )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "davinci_pas_submissions_pa_idx"
  ON "resupply"."davinci_pas_submissions"
  ("prior_authorization_id", "requested_at" DESC);
--> statement-breakpoint
