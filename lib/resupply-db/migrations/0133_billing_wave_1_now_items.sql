-- 0133_billing_wave_1_now_items — Wave 1 of the competitive-gap
-- analysis roadmap (docs/competitive-gap-analysis-2026-05-19.md).
-- Five "Now" items in one migration so the schema lands together:
--
--   1. PA Medicaid 7-day PA SLA tracking         (regulatory 4.4)
--   2. CMS PECOS ordering-provider sync          (table-stakes 3.3)
--   3. Good Faith Estimate records               (regulatory 4.5)
--   4. Annual DMEPOS accreditation surveys       (regulatory 4.1)
--   5. Heuristic predicted-denial scoring        (differentiation 5.1)
--
-- The AI inbound IVR (item 5.7) is deferred to a later migration
-- because its schema is dominated by call-session state, not by the
-- billing surface this file covers.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ────────────────────────────────────────────────────────────────────
-- 1. ALTER prior_authorizations — PA Medicaid 7-day SLA tracking
-- ────────────────────────────────────────────────────────────────────
--
-- PA DHS OpsMemo 2025-09 requires Medicaid managed-care MCOs to
-- complete standard PA decisions within 7 calendar days starting
-- 2026-01-01. The MCO is the one on the hook, but as the supplier
-- WE need to know which PAs are approaching the deadline so we can
-- nudge the MCO portal AND so our CSR queue can surface the risk
-- before a missed-SLA escalation becomes a billing gap.
--
-- The sweep job (worker/jobs/pa-mco-sla-sweep.ts) reads
-- submitted_at + payer_profile_id and stamps:
--   - mco_sla_target_date: submitted_at + 7 days (only when the
--     payer profile is a Medicaid MCO)
--   - mco_sla_status:
--       'on_track' = >= 3 days remaining
--       'at_risk'  = <= 2 days remaining
--       'missed'   = past target with no decision_at
ALTER TABLE "resupply"."prior_authorizations"
  ADD COLUMN IF NOT EXISTS "mco_sla_target_date" date,
  ADD COLUMN IF NOT EXISTS "mco_sla_status" text;
--> statement-breakpoint

ALTER TABLE "resupply"."prior_authorizations"
  DROP CONSTRAINT IF EXISTS "prior_authorizations_mco_sla_status_enum";
--> statement-breakpoint

ALTER TABLE "resupply"."prior_authorizations"
  ADD CONSTRAINT "prior_authorizations_mco_sla_status_enum"
    CHECK (
      "mco_sla_status" IS NULL
      OR "mco_sla_status" IN ('on_track', 'at_risk', 'missed', 'decided')
    );
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "prior_authorizations_mco_sla_at_risk_idx"
  ON "resupply"."prior_authorizations" ("mco_sla_status", "mco_sla_target_date")
  WHERE "mco_sla_status" IN ('at_risk', 'missed');
--> statement-breakpoint

-- Extend the CSR alert enum with the new SLA alert types.
ALTER TABLE "resupply"."csr_compliance_alerts"
  DROP CONSTRAINT IF EXISTS "csr_compliance_alerts_alert_type_enum";
--> statement-breakpoint

ALTER TABLE "resupply"."csr_compliance_alerts"
  ADD CONSTRAINT "csr_compliance_alerts_alert_type_enum"
  CHECK ("alert_type" IN (
    'low_usage',
    'no_response',
    'send_failure',
    'manual',
    'prior_auth_expiring',
    'prior_auth_expired',
    'pa_mco_sla_at_risk',
    'pa_mco_sla_missed'
  ));
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 2. providers_pecos_status — CMS PECOS ordering-provider sync
-- ────────────────────────────────────────────────────────────────────
--
-- Medicare requires the ordering physician to be PECOS-enrolled at
-- the date of service; non-enrolled = automatic denial. NPPES tells
-- us a provider EXISTS; PECOS tells us they can ORDER DME for
-- Medicare. The daily sync worker fetches the CMS public dataset
-- and upserts here.
--
-- Keyed by NPI (not provider_id) because the CMS dataset is the
-- authority and a provider can exist in NPPES + PECOS independently
-- of whether we have a `providers` row.
CREATE TABLE IF NOT EXISTS "resupply"."providers_pecos_status" (
  "npi" varchar(10) PRIMARY KEY NOT NULL,
  "enrollment_status" text NOT NULL,
  "enrollment_type" varchar(80),
  -- The "first approved date" CMS publishes — used to assert PECOS
  -- enrollment at a specific date of service.
  "first_approved_date" date,
  -- Free-text from the CMS dataset for ops triage.
  "specialty_description" varchar(160),
  -- Refresh stamp; the sweep job picks rows older than 24h.
  "last_synced_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "providers_pecos_status_npi_format"
    CHECK ("npi" ~ '^\d{10}$'),
  CONSTRAINT "providers_pecos_status_enrollment_status_enum"
    CHECK ("enrollment_status" IN (
      'approved', 'pending', 'denied', 'revoked', 'opted_out', 'unknown'
    ))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "providers_pecos_status_last_synced_idx"
  ON "resupply"."providers_pecos_status" ("last_synced_at" DESC);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 3. good_faith_estimates — No Surprises Act GFE records
-- ────────────────────────────────────────────────────────────────────
--
-- 45 CFR §149.610: uninsured / self-pay patients must receive a
-- Good Faith Estimate for scheduled DME items, in writing, BEFORE
-- the service is rendered. We capture each GFE row to prove
-- distribution + retention (3-year HHS requirement).
--
-- One row per generated estimate; immutable after creation. A
-- revision generates a NEW row, never an UPDATE.
CREATE TABLE IF NOT EXISTS "resupply"."good_faith_estimates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Customer (resolved at generation time). Nullable so anonymous
  -- pre-checkout estimates can be retained even when no account
  -- exists yet — the system stamps the email address instead.
  "customer_id" uuid,
  "recipient_name" varchar(160) NOT NULL,
  "recipient_email" varchar(180) NOT NULL,
  -- Snapshot of the line items the estimate covers, as jsonb:
  --   [{ "sku": "...", "description": "...", "hcpcs": "...",
  --      "quantity": 1, "unit_price_cents": 1499 }, ...]
  "items_json" jsonb NOT NULL,
  "total_cents" bigint NOT NULL,
  "expected_service_date" date,
  -- Object storage key for the rendered PDF. The PDF is the legal
  -- artifact; this row is the index.
  "pdf_object_key" text,
  -- Free-form disclaimer text actually printed on the PDF (so a
  -- later update to the template doesn't change what we showed
  -- the patient).
  "disclaimer_text" text NOT NULL,
  "generated_by_email" varchar(180) NOT NULL,
  "delivered_at" timestamp with time zone,
  "delivery_method" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "good_faith_estimates_total_nonneg"
    CHECK ("total_cents" >= 0),
  CONSTRAINT "good_faith_estimates_delivery_method_enum"
    CHECK (
      "delivery_method" IS NULL
      OR "delivery_method" IN ('email', 'sms', 'in_person', 'mail')
    )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "good_faith_estimates_customer_idx"
  ON "resupply"."good_faith_estimates" ("customer_id", "created_at" DESC)
  WHERE "customer_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "good_faith_estimates_created_idx"
  ON "resupply"."good_faith_estimates" ("created_at" DESC);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 4. accreditation_surveys + readiness checks
-- ────────────────────────────────────────────────────────────────────
--
-- CMS finalized the annual unannounced DMEPOS survey rule effective
-- 2026-01-01. We need to track when surveys happen + run a periodic
-- "survey-ready audit" that catches the gaps a surveyor would flag.
CREATE TABLE IF NOT EXISTS "resupply"."accreditation_surveys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL
    REFERENCES "resupply"."dme_organization"("id") ON DELETE CASCADE,
  "accreditation_body" text NOT NULL,
  "survey_type" text NOT NULL,
  -- For unannounced surveys we record the actual date AFTER the fact.
  -- For announced + projected surveys we set scheduled_for in advance.
  "scheduled_for" date,
  "completed_on" date,
  "outcome" text,
  "findings_count" integer NOT NULL DEFAULT 0,
  "corrective_action_due_on" date,
  "corrective_action_completed_on" date,
  "surveyor_name" varchar(160),
  "report_document_object_key" text,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "accreditation_surveys_body_enum"
    CHECK ("accreditation_body" IN ('achc', 'boc', 'tjc', 'cap', 'other')),
  CONSTRAINT "accreditation_surveys_type_enum"
    CHECK ("survey_type" IN (
      'initial', 'renewal', 'annual_unannounced',
      'change_of_ownership', 'complaint_driven', 'projected'
    )),
  CONSTRAINT "accreditation_surveys_outcome_enum"
    CHECK (
      "outcome" IS NULL
      OR "outcome" IN ('passed', 'passed_with_findings', 'failed', 'pending')
    )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "accreditation_surveys_org_idx"
  ON "resupply"."accreditation_surveys"
  ("organization_id", "scheduled_for" DESC NULLS LAST, "completed_on" DESC NULLS LAST);
--> statement-breakpoint

-- The readiness engine emits one row per (check_key, run_at).
-- Storing every run lets us trend "we passed all checks last week,
-- failed two this week" over the year leading up to a survey.
CREATE TABLE IF NOT EXISTS "resupply"."accreditation_readiness_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL
    REFERENCES "resupply"."dme_organization"("id") ON DELETE CASCADE,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone,
  -- Roll-up — 'ready' = all checks passed, 'gaps' = >=1 warning,
  -- 'blocking' = >=1 error.
  "overall_status" text,
  "checks_total" integer NOT NULL DEFAULT 0,
  "checks_passed" integer NOT NULL DEFAULT 0,
  "checks_warning" integer NOT NULL DEFAULT 0,
  "checks_failed" integer NOT NULL DEFAULT 0,
  CONSTRAINT "accreditation_readiness_runs_overall_status_enum"
    CHECK (
      "overall_status" IS NULL
      OR "overall_status" IN ('ready', 'gaps', 'blocking', 'errored')
    )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "accreditation_readiness_runs_started_idx"
  ON "resupply"."accreditation_readiness_runs" ("organization_id", "started_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "resupply"."accreditation_readiness_findings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL
    REFERENCES "resupply"."accreditation_readiness_runs"("id") ON DELETE CASCADE,
  "check_key" varchar(80) NOT NULL,
  "category" text NOT NULL,
  "severity" text NOT NULL,
  "label" varchar(200) NOT NULL,
  "detail" text NOT NULL,
  -- Optional structured pointer to the broken record (e.g. the
  -- staff_user_id with stale HIPAA training, the patient_documents
  -- row past its retention window, etc.)
  "target_table" varchar(80),
  "target_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "accreditation_readiness_findings_severity_enum"
    CHECK ("severity" IN ('ok', 'warning', 'error')),
  CONSTRAINT "accreditation_readiness_findings_category_enum"
    CHECK ("category" IN (
      'training', 'policy_attestation', 'patient_documents',
      'grievances', 'equipment_maintenance', 'audit_log',
      'mfa', 'identity', 'license_expiry'
    ))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "accreditation_readiness_findings_run_idx"
  ON "resupply"."accreditation_readiness_findings" ("run_id", "severity");
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 5. ALTER insurance_claims — heuristic predicted-denial scoring
-- ────────────────────────────────────────────────────────────────────
--
-- The AI scrubber catches semantic errors; the heuristic scorer (see
-- lib/billing/heuristic-denial-scorer.ts) assigns a 0..1 probability
-- the payer will reject this claim before submission. Surfaces on
-- the preflight + the billing dashboard so CSRs work the risky
-- claims first.
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "predicted_denial_probability" real,
  -- Structured factors driving the score: array of
  --   { "key": "...", "weight": 0..1, "label": "..." }
  -- Persisted for audit + so the CSR UI can explain "this scored
  -- 0.72 because: missing KX on continuing rental + Medicare
  -- requires PA for E0470".
  ADD COLUMN IF NOT EXISTS "predicted_denial_factors" jsonb,
  ADD COLUMN IF NOT EXISTS "predicted_denial_scored_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "resupply"."insurance_claims"
  DROP CONSTRAINT IF EXISTS "insurance_claims_predicted_denial_probability_range";
--> statement-breakpoint

ALTER TABLE "resupply"."insurance_claims"
  ADD CONSTRAINT "insurance_claims_predicted_denial_probability_range"
    CHECK (
      "predicted_denial_probability" IS NULL
      OR ("predicted_denial_probability" >= 0
          AND "predicted_denial_probability" <= 1)
    );
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "insurance_claims_predicted_denial_high_idx"
  ON "resupply"."insurance_claims" ("predicted_denial_probability" DESC)
  WHERE "predicted_denial_probability" IS NOT NULL
        AND "status" = 'draft'
        AND "predicted_denial_probability" >= 0.5;
