-- 0186_reconcile_prod_column_drift — backfill columns that earlier
-- migrations added but which were never applied to the PennPaps
-- production project (uppdjphagdildcgkvdsz).
--
-- Context. Follows 0178_reconcile_bucketA_column_drift. The prod project
-- still has no drizzle.resupply_migrations ledger and is behind the additive
-- ALTER migrations: the Bucket-B remediation (2026-05-30) provisioned the
-- feature-area TABLES from verbatim source migrations, but the LATER
-- ADD COLUMN migrations against them (0072, 0109, 0121, 0131, 0133, 0139,
-- 0142, 0143, 0145, 0146, 0147/0148, 0149, 0150, 0151-0153, 0156, 0157, 0167,
-- ...) were never applied. A live audit on 2026-05-31 confirmed 65 columns
-- referenced by current application code are absent on prod across 15 existing
-- tables — latent 500s of the same class as the 2026-05-30 sign-in incident
-- (e.g. GET /admin/payer-profiles, GET /admin/office-ally-submissions, the AI
-- billing queue, fitter lead capture, PA SLA queue, sleep-study ICD-10
-- suggest, provider portal). See
-- docs/incident-signin-500-schema-drift-2026-05-30.md.
--
-- Every statement is idempotent (ADD COLUMN IF NOT EXISTS) and faithful to the
-- introspected type / default / nullability of the canonical schema (the full
-- 0000..0185 chain replayed into a scratch Postgres), so re-running — or
-- running on an already-current database such as a fresh from-scratch replay
-- where these columns were already created by their original migrations — is a
-- no-op. Every NOT NULL column carries a constant DEFAULT, so the add safely
-- backfills existing rows.
--
-- SCOPE: columns only. Companion FK / CHECK / index objects from the source
-- migrations are intentionally NOT re-created here — the missing-COLUMN case is
-- what 500s the API (PostgREST rejects an unknown column); the constraints are
-- integrity/performance hardening that the application layer already enforces
-- (Zod + app logic) and are better reconciled under a deliberate, separate
-- pass once a migration ledger / runner is restored (incident follow-up #1).

-- appointment_requests video-visit link (0109) ----------------------------
ALTER TABLE "resupply"."appointment_requests"
  ADD COLUMN IF NOT EXISTS "meeting_url" text;
ALTER TABLE "resupply"."appointment_requests"
  ADD COLUMN IF NOT EXISTS "meeting_provider" varchar(32);

-- ehr_fhir_tenants outbound referral callbacks (0147/0148) -----------------
ALTER TABLE "resupply"."ehr_fhir_tenants"
  ADD COLUMN IF NOT EXISTS "callback_url" text;
ALTER TABLE "resupply"."ehr_fhir_tenants"
  ADD COLUMN IF NOT EXISTS "outbound_signing_secret" text;

-- eligibility_checks 271 -> inbound-file linkage ---------------------------
ALTER TABLE "resupply"."eligibility_checks"
  ADD COLUMN IF NOT EXISTS "applied_to_inbound_file_id" uuid;

-- era_files -> payer_profile linkage (0143) --------------------------------
ALTER TABLE "resupply"."era_files"
  ADD COLUMN IF NOT EXISTS "payer_profile_id" uuid;

-- fitter_campaign_clicks subject A/B variant (0157) ------------------------
ALTER TABLE "resupply"."fitter_campaign_clicks"
  ADD COLUMN IF NOT EXISTS "subject_variant_key" text NOT NULL DEFAULT 'A'::text;

-- fitter_leads phone/source/engagement + CSR notes/cold-skip
-- (0121, 0151-0153, 0156) --------------------------------------------------
ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'consent'::text;
ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "first_name" text;
ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "phone_e164" text;
ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "sms_opt_in" boolean NOT NULL DEFAULT false;
ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "engagement_score" integer NOT NULL DEFAULT 0;
ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "nudged_at" timestamp with time zone;
ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "first_day_nudged_at" timestamp with time zone;
ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "cold_skipped_at" timestamp with time zone;
ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "csr_notes" text;

-- inbound_referral_orders AI classification + match/preflight (0145/0146) ---
ALTER TABLE "resupply"."inbound_referral_orders"
  ADD COLUMN IF NOT EXISTS "ai_classification_json" jsonb;
ALTER TABLE "resupply"."inbound_referral_orders"
  ADD COLUMN IF NOT EXISTS "ai_confidence" numeric(3,2);
ALTER TABLE "resupply"."inbound_referral_orders"
  ADD COLUMN IF NOT EXISTS "patient_match_kind" varchar(40);
ALTER TABLE "resupply"."inbound_referral_orders"
  ADD COLUMN IF NOT EXISTS "provider_match_kind" varchar(40);
ALTER TABLE "resupply"."inbound_referral_orders"
  ADD COLUMN IF NOT EXISTS "preflight_completed_at" timestamp with time zone;

-- inbound_webhooks processing-status bookkeeping (0157) --------------------
ALTER TABLE "resupply"."inbound_webhooks"
  ADD COLUMN IF NOT EXISTS "processing_started_at" timestamp with time zone;
ALTER TABLE "resupply"."inbound_webhooks"
  ADD COLUMN IF NOT EXISTS "processing_attempts" smallint NOT NULL DEFAULT 0;

-- insurance_claims AI scrub verdict + predicted-denial scoring (0131/0133) --
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "latest_scrub_verdict" text;
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "latest_scrub_at" timestamp with time zone;
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "latest_scrub_result_id" uuid;
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "latest_denial_analysis_id" uuid;
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "predicted_denial_probability" real;
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "predicted_denial_factors" jsonb;
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "predicted_denial_scored_at" timestamp with time zone;

-- office_ally_submissions resubmit chain (0150) ----------------------------
ALTER TABLE "resupply"."office_ally_submissions"
  ADD COLUMN IF NOT EXISTS "attempted_claim_ids" uuid[] NOT NULL DEFAULT '{}'::uuid[];
ALTER TABLE "resupply"."office_ally_submissions"
  ADD COLUMN IF NOT EXISTS "parent_submission_id" uuid;

-- payer_profiles completeness + PA phase-2 (0142, 0149) --------------------
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "claims_address_line1" varchar(120);
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "claims_address_line2" varchar(120);
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "claims_city" varchar(80);
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "claims_state" varchar(2);
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "claims_zip" varchar(10);
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "claims_phone_e164" varchar(20);
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "claims_fax_e164" varchar(20);
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "claims_mailing_address" jsonb;
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "appeals_mailing_address" jsonb;
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "timely_filing_days" smallint;
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "required_claim_modifiers" text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "required_modifiers_dme" text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "edi_enrollment_status" text NOT NULL DEFAULT 'not_applicable'::text;
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "enrollment_status" text NOT NULL DEFAULT 'unknown'::text;
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "enrollment_effective_on" date;
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "member_id_pattern" varchar(200);
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "member_id_format_hint" varchar(120);
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "davinci_pas_endpoint_url" text;
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "prior_auth_submission_method" text;
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "prior_auth_fax_e164" varchar(20);
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "prior_auth_turnaround_business_days" smallint;
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "accepts_electronic_secondary" boolean NOT NULL DEFAULT true;
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "requirements_last_verified_at" timestamp with time zone;
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "requirements_last_verified_by" varchar(180);
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "requires_referring_provider_npi" boolean NOT NULL DEFAULT false;

-- prescriptions -> providers linkage (0072). providers now exists on prod
-- (Bucket B), so this column — deliberately excluded from 0178 — is added
-- here. Plain uuid column; the FK constraint is part of the deferred
-- constraint-hardening pass (see header).
ALTER TABLE "resupply"."prescriptions"
  ADD COLUMN IF NOT EXISTS "provider_id" uuid;

-- prior_authorizations MCO SLA tracking (0133) -----------------------------
ALTER TABLE "resupply"."prior_authorizations"
  ADD COLUMN IF NOT EXISTS "mco_sla_status" text;
ALTER TABLE "resupply"."prior_authorizations"
  ADD COLUMN IF NOT EXISTS "mco_sla_target_date" date;

-- providers patient-facing portal link versioning (0167) -------------------
ALTER TABLE "resupply"."providers"
  ADD COLUMN IF NOT EXISTS "portal_link_version" integer NOT NULL DEFAULT 0;

-- sleep_studies AI ICD-10 diagnosis suggestion (0139) ----------------------
ALTER TABLE "resupply"."sleep_studies"
  ADD COLUMN IF NOT EXISTS "diagnosis_source" text;
ALTER TABLE "resupply"."sleep_studies"
  ADD COLUMN IF NOT EXISTS "diagnosis_ai_confidence" real;
ALTER TABLE "resupply"."sleep_studies"
  ADD COLUMN IF NOT EXISTS "diagnosis_ai_model" varchar(80);
ALTER TABLE "resupply"."sleep_studies"
  ADD COLUMN IF NOT EXISTS "diagnosis_ai_suggested_at" timestamp with time zone;
