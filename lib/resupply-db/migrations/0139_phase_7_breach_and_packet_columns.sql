-- 0139_phase_7_breach_and_packet_columns — Phase 8 schema deltas:
--
--   1. hipaa_breach_incidents — single source of truth for HIPAA
--      breach lifecycle: discovery, investigation, mitigation,
--      individual + HHS + media notification timing. Surveyors
--      ask "show me the last 12 months of breach incidents" and
--      we need a defensible table to point at.
--   2. ALTER inbound_webhooks: add processing_attempts (smallint)
--      so dispatcher retries surface in the audit.
--   3. ALTER sleep_studies: add diagnosis_source enum + diagnosis_ai_*
--      columns so we can tell "this code came from the lab" from
--      "this code came from our AI suggester" — important for the
--      audit trail and for the future model-retraining loop.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ────────────────────────────────────────────────────────────────────
-- 1. hipaa_breach_incidents
-- ────────────────────────────────────────────────────────────────────
--
-- 45 CFR §164.404-414 requires written notification to affected
-- individuals within 60 days of breach discovery, HHS within 60
-- days for breaches >= 500 individuals (annual for <500), and
-- prominent media outlets for breaches >= 500 individuals in a
-- state. We track every incident — including those determined
-- NOT to be a breach after risk assessment — so surveyors can see
-- the full evaluation history.
CREATE TABLE IF NOT EXISTS "resupply"."hipaa_breach_incidents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Short slug for the incident; used in audit log messages.
  "slug" varchar(80) NOT NULL UNIQUE,
  -- One-line summary safe to log.
  "title" varchar(240) NOT NULL,
  -- Long-form description (kept jsonb so investigators can attach
  -- structured fields incrementally).
  "description" text NOT NULL,
  -- Lifecycle:
  --   under_investigation -> not_a_breach | confirmed_breach
  --   confirmed_breach -> resolved
  "status" text NOT NULL DEFAULT 'under_investigation',
  -- Kind of incident — drives the surveyor binder layout.
  "kind" text NOT NULL,
  "severity" text NOT NULL,
  "individuals_affected" integer,
  "media_notification_required" boolean NOT NULL DEFAULT false,
  -- Risk-assessment outcome (from the 4-factor §164.402(2) test).
  -- Captured even when the conclusion is 'not_a_breach' so the
  -- evaluation work is auditable.
  "risk_assessment" text,
  "mitigation" text,
  -- Discovery + notification clocks. The 60-day individual clock
  -- starts at `discovered_at`.
  "discovered_at" timestamp with time zone NOT NULL,
  "individuals_notified_at" timestamp with time zone,
  "hhs_notified_at" timestamp with time zone,
  "media_notified_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  -- Free-form list of HIPAA-affected systems / data categories.
  "affected_systems" text[] NOT NULL DEFAULT '{}',
  -- Owner — the named individual responsible for closing this
  -- incident (the compliance officer per the policy).
  "owner_email" varchar(180),
  -- Free-form notes; investigators append timestamped entries.
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "hipaa_breach_incidents_slug_format"
    CHECK ("slug" ~ '^[a-z0-9_-]+$'),
  CONSTRAINT "hipaa_breach_incidents_status_enum"
    CHECK ("status" IN (
      'under_investigation',
      'not_a_breach',
      'confirmed_breach',
      'resolved'
    )),
  CONSTRAINT "hipaa_breach_incidents_kind_enum"
    CHECK ("kind" IN (
      'lost_device',
      'misdirected_fax',
      'misdirected_email',
      'unauthorized_access',
      'phishing',
      'malware',
      'business_associate',
      'mailing_error',
      'paper_disposal',
      'other'
    )),
  CONSTRAINT "hipaa_breach_incidents_severity_enum"
    CHECK ("severity" IN ('low', 'moderate', 'high', 'critical')),
  CONSTRAINT "hipaa_breach_incidents_individuals_nonneg"
    CHECK (
      "individuals_affected" IS NULL OR "individuals_affected" >= 0
    )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "hipaa_breach_incidents_status_idx"
  ON "resupply"."hipaa_breach_incidents" ("status", "discovered_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "hipaa_breach_incidents_owner_idx"
  ON "resupply"."hipaa_breach_incidents" ("owner_email")
  WHERE "owner_email" IS NOT NULL;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 2. ALTER inbound_webhooks: processing_attempts
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE "resupply"."inbound_webhooks"
  ADD COLUMN IF NOT EXISTS "processing_attempts" smallint NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "resupply"."inbound_webhooks"
  DROP CONSTRAINT IF EXISTS "inbound_webhooks_processing_attempts_nonneg";
--> statement-breakpoint

ALTER TABLE "resupply"."inbound_webhooks"
  ADD CONSTRAINT "inbound_webhooks_processing_attempts_nonneg"
    CHECK ("processing_attempts" >= 0);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 3. ALTER sleep_studies: diagnosis provenance
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE "resupply"."sleep_studies"
  ADD COLUMN IF NOT EXISTS "diagnosis_source" text,
  ADD COLUMN IF NOT EXISTS "diagnosis_ai_confidence" real,
  ADD COLUMN IF NOT EXISTS "diagnosis_ai_model" varchar(80),
  ADD COLUMN IF NOT EXISTS "diagnosis_ai_suggested_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "resupply"."sleep_studies"
  DROP CONSTRAINT IF EXISTS "sleep_studies_diagnosis_source_enum";
--> statement-breakpoint

ALTER TABLE "resupply"."sleep_studies"
  ADD CONSTRAINT "sleep_studies_diagnosis_source_enum"
    CHECK (
      "diagnosis_source" IS NULL
      OR "diagnosis_source" IN (
        'lab_report',
        'csr_entry',
        'ai_suggested',
        'ai_accepted',
        'imported'
      )
    );
--> statement-breakpoint

ALTER TABLE "resupply"."sleep_studies"
  DROP CONSTRAINT IF EXISTS "sleep_studies_diagnosis_ai_confidence_range";
--> statement-breakpoint

ALTER TABLE "resupply"."sleep_studies"
  ADD CONSTRAINT "sleep_studies_diagnosis_ai_confidence_range"
    CHECK (
      "diagnosis_ai_confidence" IS NULL
      OR (
        "diagnosis_ai_confidence" >= 0
        AND "diagnosis_ai_confidence" <= 1
      )
    );
