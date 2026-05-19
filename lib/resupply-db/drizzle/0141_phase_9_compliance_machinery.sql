-- 0141_phase_9_compliance_machinery — close the major compliance
-- gaps identified by the May 2026 regulatory + code audit. Eight
-- new tables covering:
--
--   1. business_associate_agreements — HIPAA §164.504(e) BAA inventory.
--   2. oig_leie_exclusions + oig_leie_screenings — Medicare/Medicaid
--      OIG LEIE exclusion-list checks (monthly required cadence).
--   3. patient_rights_requests — HIPAA §164.522 / §164.524 / §164.526
--      / §164.528: unified workflow table for access, amendment,
--      accounting, restriction, confidential-communications requests.
--   4. patient_disclosure_log — append-only record of every PHI
--      disclosure made for non-TPO purposes, used to answer §164.528
--      accounting requests.
--   5. hipaa_risk_assessments — §164.308(a)(1)(ii)(A) annual risk
--      analysis tracking.
--   6. contingency_plan_attestations + disaster_preparedness_drills —
--      §164.308(a)(7) contingency plan + ACHC disaster preparedness.
--   7. quality_improvement_initiatives — ACHC QAPI tracking.
--   8. dme_ownership_disclosures — §424.57(c)(17) ownership/control
--      structure disclosure.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ────────────────────────────────────────────────────────────────────
-- 1. business_associate_agreements
-- ────────────────────────────────────────────────────────────────────
--
-- HIPAA §164.502(e) + §164.504(e): every BA that touches PHI must
-- have a signed BAA on file BEFORE PHI exchange. The 2025 NPRM
-- proposes annual written verification of BA safeguards on top.
CREATE TABLE IF NOT EXISTS "resupply"."business_associate_agreements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "vendor_slug" varchar(64) NOT NULL UNIQUE,
  "vendor_legal_name" varchar(200) NOT NULL,
  -- What kind of BA relationship — drives the audit posture.
  "vendor_kind" text NOT NULL,
  -- Scope of PHI the BA touches; jsonb so we can enumerate elements
  -- without a constraint enum that lags reality.
  --   { "categories": ["demographic","clinical","claims","payments"],
  --     "transport": ["api","sftp","ad-hoc"] }
  "scope_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "agreement_signed_on" date,
  "agreement_expires_on" date,
  -- Object storage key for the signed PDF.
  "agreement_document_object_key" text,
  -- 2025 NPRM annual-verification: most recent date the BA's
  -- safeguard attestation landed.
  "last_safeguard_attestation_on" date,
  -- HITRUST / SOC 2 / equivalent — informational for procurement.
  "compliance_certifications" text[] NOT NULL DEFAULT '{}',
  "vendor_contact_email" varchar(180),
  "vendor_contact_phone_e164" varchar(20),
  "internal_owner_email" varchar(180),
  "status" text NOT NULL DEFAULT 'active',
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "baa_vendor_slug_format"
    CHECK ("vendor_slug" ~ '^[a-z0-9_-]+$'),
  CONSTRAINT "baa_vendor_kind_enum"
    CHECK ("vendor_kind" IN (
      'clearinghouse',
      'cloud_infrastructure',
      'email_provider',
      'sms_telecom_provider',
      'ai_llm_provider',
      'payment_processor',
      'storage_provider',
      'eprescribe',
      'analytics',
      'other'
    )),
  CONSTRAINT "baa_status_enum"
    CHECK ("status" IN ('active', 'expired', 'terminated', 'pending'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "baa_status_idx"
  ON "resupply"."business_associate_agreements" ("status");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "baa_expiring_idx"
  ON "resupply"."business_associate_agreements" ("agreement_expires_on")
  WHERE "agreement_expires_on" IS NOT NULL;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 2. oig_leie_exclusions + oig_leie_screenings
-- ────────────────────────────────────────────────────────────────────
--
-- Industry standard: screen every employee / contractor / vendor /
-- ordering provider against the OIG List of Excluded Individuals
-- and Entities monthly (OIG SAB 2013). The two-table design
-- separates the cached LEIE row from the per-subject screening
-- attempt so we can prove "we checked, the list said no hit, on
-- this date" even after the LEIE row turns over.
CREATE TABLE IF NOT EXISTS "resupply"."oig_leie_exclusions" (
  -- The composite key the OIG file uses: NPI when present,
  -- otherwise lastname+firstname+dob hash. We cache both forms.
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "npi" varchar(10),
  "lastname" varchar(80) NOT NULL,
  "firstname" varchar(80),
  "middlename" varchar(80),
  -- HHS OIG provider type code (e.g. INDIVIDUAL, ENTITY).
  "subject_type" text NOT NULL,
  -- OIG exclusion type — 1128(a)(1)..(a)(4), 1128(b)(1)..(b)(15).
  "exclusion_type" varchar(20) NOT NULL,
  "exclusion_date" date NOT NULL,
  -- Optional waiver / reinstatement date.
  "waiver_date" date,
  "reinstate_date" date,
  -- The address-line the LEIE file lists; helps disambiguate
  -- common names.
  "address_state" varchar(2),
  "address_city" varchar(80),
  -- Refresh stamp + source file (the LEIE is monthly published).
  "loaded_at" timestamp with time zone NOT NULL DEFAULT now(),
  "source_file_version" varchar(20),
  CONSTRAINT "oig_leie_npi_format"
    CHECK ("npi" IS NULL OR "npi" ~ '^\d{10}$')
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "oig_leie_npi_idx"
  ON "resupply"."oig_leie_exclusions" ("npi")
  WHERE "npi" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "oig_leie_name_idx"
  ON "resupply"."oig_leie_exclusions" ("lastname", "firstname");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "resupply"."oig_leie_screenings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- What we're screening. The optional FKs are SET NULL so a
  -- staff/provider/BAA delete doesn't break the screening history.
  "subject_kind" text NOT NULL,
  "subject_admin_user_id" uuid
    REFERENCES "resupply_auth"."users"("id") ON DELETE SET NULL,
  "subject_provider_id" uuid
    REFERENCES "resupply"."providers"("id") ON DELETE SET NULL,
  "subject_baa_id" uuid
    REFERENCES "resupply"."business_associate_agreements"("id") ON DELETE SET NULL,
  -- Free-form text identity used when no FK matches (legacy
  -- workforce, contractors not in admin_users yet).
  "subject_label" varchar(200) NOT NULL,
  "subject_npi" varchar(10),
  -- The screening result.
  "result" text NOT NULL,
  -- When result = 'hit', the matching exclusion row.
  "matched_exclusion_id" uuid
    REFERENCES "resupply"."oig_leie_exclusions"("id") ON DELETE SET NULL,
  -- Free-form note (e.g. "matched but not our provider — verified
  -- via DOB").
  "disposition_note" text,
  "screened_by_email" varchar(180) NOT NULL,
  "screened_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "oig_leie_screenings_subject_kind_enum"
    CHECK ("subject_kind" IN (
      'admin_user', 'provider', 'business_associate', 'contractor', 'owner'
    )),
  CONSTRAINT "oig_leie_screenings_result_enum"
    CHECK ("result" IN ('clear', 'hit', 'inconclusive', 'errored')),
  CONSTRAINT "oig_leie_screenings_subject_npi_format"
    CHECK ("subject_npi" IS NULL OR "subject_npi" ~ '^\d{10}$')
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "oig_leie_screenings_subject_idx"
  ON "resupply"."oig_leie_screenings" ("subject_kind", "screened_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "oig_leie_screenings_hit_idx"
  ON "resupply"."oig_leie_screenings" ("result", "screened_at" DESC)
  WHERE "result" = 'hit';
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 3. patient_rights_requests
-- ────────────────────────────────────────────────────────────────────
--
-- Unified workflow table for the four §164.522/524/526/528 rights:
--   * access (§164.524)
--   * amendment (§164.526)
--   * accounting_of_disclosures (§164.528)
--   * restriction (§164.522(a))
--   * confidential_communications (§164.522(b))
--
-- 30-day response clock per §164.524(b)(2) (single 30-day extension
-- allowed; the route writes extension_granted_at to start the
-- second window).
CREATE TABLE IF NOT EXISTS "resupply"."patient_rights_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "request_kind" text NOT NULL,
  "submitted_via" text NOT NULL,
  -- The verbatim request body the patient (or their representative)
  -- supplied. Plain-text; PHI-bearing by design.
  "request_body" text NOT NULL,
  -- Structured contextual fields by kind:
  --   amendment: { record_table, record_id, proposed_value }
  --   restriction: { restricted_use, restricted_disclosures }
  --   confidential_communications: { preferred_channel, address }
  --   access: { record_categories, format_preference }
  --   accounting: { from_date, to_date }
  "request_details_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Lifecycle.
  "status" text NOT NULL DEFAULT 'received',
  -- 30-day response clock per §164.524(b)(2).
  "received_at" timestamp with time zone NOT NULL DEFAULT now(),
  "extension_granted_at" timestamp with time zone,
  "decision" text,
  "decision_rationale" text,
  "decided_at" timestamp with time zone,
  "decided_by_email" varchar(180),
  -- Optional pointer to the document we sent back (amendment letter,
  -- accounting report, denial letter).
  "response_document_object_key" text,
  "delivered_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "patient_rights_kind_enum"
    CHECK ("request_kind" IN (
      'access',
      'amendment',
      'accounting_of_disclosures',
      'restriction',
      'confidential_communications'
    )),
  CONSTRAINT "patient_rights_submitted_via_enum"
    CHECK ("submitted_via" IN (
      'patient_portal', 'phone', 'email', 'mail', 'in_person',
      'representative'
    )),
  CONSTRAINT "patient_rights_status_enum"
    CHECK ("status" IN (
      'received', 'in_review', 'extended', 'granted',
      'partially_granted', 'denied', 'withdrawn', 'expired'
    )),
  CONSTRAINT "patient_rights_decision_enum"
    CHECK (
      "decision" IS NULL
      OR "decision" IN ('granted', 'partially_granted', 'denied')
    )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "patient_rights_patient_idx"
  ON "resupply"."patient_rights_requests" ("patient_id", "received_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "patient_rights_open_idx"
  ON "resupply"."patient_rights_requests" ("status", "received_at")
  WHERE "status" IN ('received', 'in_review', 'extended');
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 4. patient_disclosure_log
-- ────────────────────────────────────────────────────────────────────
--
-- §164.528: patients can request a 6-year accounting of every
-- disclosure of their PHI made for non-TPO (treatment/payment/
-- healthcare-operations) purposes. The log captures every such
-- disclosure when it happens; the §164.528-response route reads
-- this for the requested date range.
CREATE TABLE IF NOT EXISTS "resupply"."patient_disclosure_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  -- The recipient — free-form because disclosures go to many
  -- entities (researchers, courts, public-health authorities).
  "recipient_name" varchar(200) NOT NULL,
  "recipient_address" text,
  -- §164.528 disclosure-purpose categories that DO require accounting
  -- (TPO is excluded BY DEFINITION).
  "disclosure_purpose" text NOT NULL,
  -- Short description the patient will read on the accounting report.
  "description" text NOT NULL,
  -- The legal authority for the disclosure (subpoena number,
  -- statute citation, court order id).
  "legal_authority" text,
  -- True iff the disclosure was made under a signed patient
  -- authorization (which doesn't require accounting per §164.528(a)
  -- (1) but we still log for audit).
  "patient_authorized" boolean NOT NULL DEFAULT false,
  "disclosed_at" timestamp with time zone NOT NULL,
  "disclosed_by_email" varchar(180) NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "patient_disclosure_purpose_enum"
    CHECK ("disclosure_purpose" IN (
      'public_health',
      'health_oversight',
      'judicial_administrative',
      'law_enforcement',
      'decedents',
      'cadaveric_organ_eye_tissue',
      'research',
      'serious_threat',
      'specialized_government',
      'workers_compensation',
      'reporting_abuse_or_neglect',
      'fda_product_safety',
      'other'
    ))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "patient_disclosure_patient_idx"
  ON "resupply"."patient_disclosure_log" ("patient_id", "disclosed_at" DESC);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 5. hipaa_risk_assessments
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."hipaa_risk_assessments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Year of the assessment cycle.
  "assessment_year" smallint NOT NULL,
  -- Methodology — internal | third_party (with vendor).
  "methodology" text NOT NULL,
  "vendor_name" varchar(200),
  "scope_summary" text NOT NULL,
  -- High-level scoring across the §164.308(a)(1)(ii) categories.
  --   { risks: [{ id, description, likelihood, impact, status }],
  --     summary: { total, high, moderate, low } }
  "findings_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "remediation_plan" text,
  "executive_summary" text,
  "completed_on" date NOT NULL,
  "report_document_object_key" text,
  "owner_email" varchar(180) NOT NULL,
  "approved_by_email" varchar(180),
  "approved_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "hipaa_risk_assessments_year_range"
    CHECK ("assessment_year" >= 2020 AND "assessment_year" <= 2099),
  CONSTRAINT "hipaa_risk_assessments_methodology_enum"
    CHECK ("methodology" IN ('internal', 'third_party'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "hipaa_risk_assessments_year_uq"
  ON "resupply"."hipaa_risk_assessments" ("assessment_year");
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 6. contingency_plan_attestations + disaster_preparedness_drills
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."contingency_plan_attestations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "plan_version" varchar(40) NOT NULL,
  "plan_document_object_key" text,
  "attested_by_email" varchar(180) NOT NULL,
  "attested_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- 2025 NPRM: 72-hour RTO target. Captured as informational so the
  -- attestation history shows when the org committed to the SLA.
  "documented_rto_hours" integer NOT NULL DEFAULT 72,
  "documented_rpo_hours" integer NOT NULL DEFAULT 24,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "contingency_plan_attested_idx"
  ON "resupply"."contingency_plan_attestations" ("attested_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "resupply"."disaster_preparedness_drills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "drill_kind" text NOT NULL,
  "scenario" text NOT NULL,
  "executed_on" date NOT NULL,
  -- Was the documented RTO met during the drill?
  "rto_target_hours" integer,
  "rto_actual_hours" integer,
  "participants_count" integer,
  -- Structured findings + corrective actions.
  --   { issues: [{description, severity, owner, due_date}],
  --     corrective_actions_taken: "..." }
  "outcome_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "lead_email" varchar(180) NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "drill_kind_enum"
    CHECK ("drill_kind" IN (
      'tabletop', 'partial_failover', 'full_failover',
      'data_restore', 'pandemic_response',
      'cyber_incident_response', 'physical_outage', 'other'
    ))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "disaster_drills_executed_idx"
  ON "resupply"."disaster_preparedness_drills" ("executed_on" DESC);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 7. quality_improvement_initiatives
-- ────────────────────────────────────────────────────────────────────
--
-- ACHC requires a QAPI program with at least 4 indicators tracked
-- quarterly + an annual evaluation. Per-initiative row + per-
-- measurement child table.
CREATE TABLE IF NOT EXISTS "resupply"."quality_improvement_initiatives" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" varchar(80) NOT NULL UNIQUE,
  "title" varchar(200) NOT NULL,
  "description" text NOT NULL,
  -- ACHC-aligned categories.
  "category" text NOT NULL,
  -- Measurement target — e.g. "denial rate < 5%", "first-call
  -- resolution > 80%", "patient satisfaction > 4.5/5".
  "target_metric" varchar(240) NOT NULL,
  "baseline_metric" varchar(240),
  "owner_email" varchar(180) NOT NULL,
  "started_on" date NOT NULL,
  "concluded_on" date,
  "status" text NOT NULL DEFAULT 'active',
  "annual_evaluation_summary" text,
  "annual_evaluation_completed_on" date,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "qi_category_enum"
    CHECK ("category" IN (
      'patient_safety',
      'patient_satisfaction',
      'clinical_outcomes',
      'billing_accuracy',
      'service_delivery',
      'workforce_competency',
      'infection_control',
      'equipment_management',
      'other'
    )),
  CONSTRAINT "qi_status_enum"
    CHECK ("status" IN ('active', 'on_hold', 'concluded', 'cancelled'))
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "resupply"."quality_improvement_measurements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "initiative_id" uuid NOT NULL
    REFERENCES "resupply"."quality_improvement_initiatives"("id") ON DELETE CASCADE,
  -- Reporting period (typically the quarter the measurement covers).
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "metric_value" varchar(240) NOT NULL,
  -- PDSA cycle: plan-do-study-act notes for this measurement.
  "study_findings" text,
  "act_corrective_actions" text,
  "recorded_by_email" varchar(180) NOT NULL,
  "recorded_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "qi_measurement_period"
    CHECK ("period_end" >= "period_start")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "qi_measurements_initiative_idx"
  ON "resupply"."quality_improvement_measurements"
  ("initiative_id", "period_end" DESC);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 8. dme_ownership_disclosures
-- ────────────────────────────────────────────────────────────────────
--
-- §424.57(c)(17): supplier must disclose ownership / managing-control
-- persons + relationships to other Medicare providers. Captured per
-- person so the CMS-855S section 5 history is auditable.
CREATE TABLE IF NOT EXISTS "resupply"."dme_ownership_disclosures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL
    REFERENCES "resupply"."dme_organization"("id") ON DELETE CASCADE,
  "person_legal_name" varchar(200) NOT NULL,
  "person_role" text NOT NULL,
  -- For corporate owners: org-level owner percentage. Null for
  -- individuals reported as managing-control only.
  "ownership_pct" numeric(5, 2),
  -- True iff the person is an owner/director of another currently
  -- Medicare-enrolled provider — required by 855S section 5.
  "related_provider_disclosed" boolean NOT NULL DEFAULT false,
  "related_provider_description" text,
  "ssn_last4" varchar(4),
  "tax_id" varchar(9),
  "disclosed_on" date NOT NULL,
  "removed_on" date,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "ownership_person_role_enum"
    CHECK ("person_role" IN (
      'owner', 'partner', 'officer', 'director',
      'managing_employee', 'agent', 'authorized_official'
    )),
  CONSTRAINT "ownership_pct_range"
    CHECK (
      "ownership_pct" IS NULL
      OR ("ownership_pct" >= 0 AND "ownership_pct" <= 100)
    ),
  CONSTRAINT "ownership_ssn_format"
    CHECK ("ssn_last4" IS NULL OR "ssn_last4" ~ '^\d{4}$'),
  CONSTRAINT "ownership_tax_id_format"
    CHECK ("tax_id" IS NULL OR "tax_id" ~ '^\d{9}$')
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "dme_ownership_org_active_idx"
  ON "resupply"."dme_ownership_disclosures" ("organization_id")
  WHERE "removed_on" IS NULL;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 9. Extend accreditation_readiness_findings.category enum so the
--    readiness engine can surface the new compliance gaps.
-- ────────────────────────────────────────────────────────────────────
--
-- Adds: baa_expiry, oig_screening, risk_assessment, contingency_plan,
--       qi_program. The pre-existing 9 categories (training,
--       policy_attestation, patient_documents, grievances,
--       equipment_maintenance, audit_log, mfa, identity, license_expiry)
--       carry over unchanged.
ALTER TABLE "resupply"."accreditation_readiness_findings"
  DROP CONSTRAINT IF EXISTS "accreditation_readiness_findings_category_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."accreditation_readiness_findings"
  ADD CONSTRAINT "accreditation_readiness_findings_category_enum"
  CHECK ("category" IN (
    'training', 'policy_attestation', 'patient_documents',
    'grievances', 'equipment_maintenance', 'audit_log',
    'mfa', 'identity', 'license_expiry',
    'baa_expiry', 'oig_screening', 'risk_assessment',
    'contingency_plan', 'qi_program'
  ));
--> statement-breakpoint
