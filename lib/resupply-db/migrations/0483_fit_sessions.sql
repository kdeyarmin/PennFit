-- 0483_fit_sessions — the clinical record of one fitting.
--
-- Why
-- ---
-- Today a completed fitting leaves two traces: a jsonb blob on
-- fitter_invites (measurements / questionnaire_answers / recommendations)
-- and, after delivery, a three-button micro-survey in mask_fit_outcomes.
-- Neither records HOW the recommendation was reached — which rules ran,
-- which formulary version was in force, how good the scan was, what was
-- ruled out and why, whether a clinician agreed. A fit report that a
-- sleep lab, an RT, or a payer can rely on needs all of that, and needs
-- it stamped at compute time so a report reprinted a year later shows the
-- rules that ACTUALLY ran rather than today's.
--
-- Model
-- -----
--   fit_sessions                   — one row per fitting
--   fit_session_events             — append-only provenance trail
--   fit_session_safety_responses   — the magnetic/safety screen answers
--
-- A NEW table rather than more columns on fitter_invites: that table is
-- the delivery + attach record, with a settled six-state lifecycle, three
-- consuming admin surfaces, and per-fitting metering hanging off it.
-- Bolting ~40 clinical columns onto it would break its shape. One
-- fit_sessions row per fitting, FK back to the invite, and the legacy
-- jsonb columns keep being written so no existing surface regresses.
--
-- `population` (adult/pediatric) and `service_line` (pap/niv) are carried
-- from day one. The separately-validated Pediatric and NIV modules are
-- later work, but they must not need a schema migration to arrive.
--
-- ON fit_session_events AND THE AUDIT RULE
-- ----------------------------------------
-- This is an ordinary feature-owned domain table. It is NOT
-- resupply.audit_log and does NOT go through @workspace/resupply-audit
-- (a retired no-op stub). The repo rule forbids new audit_log
-- readers/writers; a purpose-built provenance table for a purpose-built
-- clinical report is the compliant way to get the history the report
-- needs. Staff MUTATIONS additionally write public.admin_audit_log,
-- which is alive and org-scoped since 0477.
--
-- PHI
-- ---
-- fit_sessions holds facial measurements, health questionnaire answers,
-- and safety-screen answers about the patient AND their household. Same
-- PHI class as fitter_invites, governed by the same service-role
-- boundary. Two hard rules:
--   * `measurements` and `measurement_frames` hold NUMBERS ONLY — never
--     an image, never a raw landmark dump that could be re-projected
--     into a face. The on-device-only invariant is unchanged.
--   * `fit_session_events.detail` is Zod-validated on write and carries
--     ids / codes / counts only, never free-text PHI.
--
-- Per ADR 003 — versioned hand-authored migration. Tenant-scoped via
-- org_id (auto-tagged by the org-scoped Supabase client on every insert).

-- ---------------------------------------------------------------
-- fit_sessions
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply"."fit_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  "location_id" uuid REFERENCES "resupply"."locations"("id"),
  -- The invite this fitting came from, when it came from one.
  "fitter_invite_id" uuid
    REFERENCES "resupply"."fitter_invites"("id") ON DELETE SET NULL,
  -- SET NULL so deleting a chart doesn't erase the fitting record.
  "patient_id" uuid
    REFERENCES "resupply"."patients"("id") ON DELETE SET NULL,

  -- How the patient reached the fitter. 'kiosk_qr' and 'in_office' are
  -- carried now so the later provider-portal entry points slot in
  -- without a migration.
  "entry_point" text NOT NULL DEFAULT 'remote_link',
  "population" text NOT NULL DEFAULT 'adult',
  "service_line" text NOT NULL DEFAULT 'pap',
  "payer_profile_id" uuid REFERENCES "resupply"."payer_profiles"("id"),
  "contract_ref" text,

  "status" text NOT NULL DEFAULT 'in_progress',

  -- ── Capture. Numbers only. ──
  "measurements" jsonb,
  -- Per-frame values + quality subscores + pose angles. Numbers only.
  "measurement_frames" jsonb,
  "calibration_method" text,
  "frame_count" integer NOT NULL DEFAULT 1,
  -- {lighting, distance, pose, occlusion, motion, framing} each 0..1.
  "scan_quality" jsonb,
  "scan_quality_grade" text,
  -- Per-measurement cross-frame agreement, 0..1. The one reliability
  -- signal a single frame can never produce.
  "measurement_agreement" jsonb,
  "measurement_confidence" numeric(4, 3),
  "measurement_confidence_band" text,

  -- ── Patient Fit Profile. ──
  "profile_answers" jsonb,
  "profile_version" text NOT NULL DEFAULT 'fit_profile_v1',

  -- ── Safety screening. ──
  "safety_screen_version" text,
  "safety_flags" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "safety_attested_at" timestamp with time zone,
  -- Verbatim prompts + answers + attestation text AS SHOWN, snapshotted
  -- so the report reproduces exactly what the patient agreed to.
  "safety_snapshot" jsonb,

  -- ── Results. ──
  "primary_mask_model_id" uuid REFERENCES "resupply"."mask_models"("id"),
  "primary_cushion_variant_id" uuid
    REFERENCES "resupply"."mask_size_variants"("id"),
  "primary_frame_variant_id" uuid
    REFERENCES "resupply"."mask_size_variants"("id"),
  "primary_recommendation" jsonb,
  "alternatives" jsonb,
  -- What was filtered out and why. This is the defensibility record —
  -- "we considered and ruled out X because Y" — and is deliberately
  -- kept OUT of `alternatives` so the two never blur.
  "excluded" jsonb,
  "recommendation_confidence" numeric(4, 3),
  "outcome" text,

  -- ── Provenance. Stamped at compute time, NEVER recomputed on read. ──
  "rules_engine_version" text NOT NULL,
  "formulary_id" uuid REFERENCES "resupply"."formularies"("id"),
  "formulary_version" integer,
  -- Snapshotted, not joined. A formulary can be renamed, and the FK is
  -- ON DELETE-less by design, but a report reprinted a year later has to
  -- name the formulary AS IT WAS when the recommendation ran — resolving
  -- it live would quietly rewrite history.
  "formulary_name" text,
  -- The rule ids that actually fired, per candidate.
  "formulary_rules_matched" jsonb,
  "catalog_snapshot_version" integer,
  "fit_adjustments_applied" jsonb,
  -- True when the tenant catalog/formulary could not be loaded and the
  -- engine fell back to the built-in catalog. The report says so.
  "degraded" boolean NOT NULL DEFAULT false,

  -- ── Clinician disposition. ──
  "review_status" text NOT NULL DEFAULT 'not_required',
  "reviewed_by_user_id" uuid,
  "reviewed_by_email" text,
  "reviewed_at" timestamp with time zone,
  "override_mask_model_id" uuid REFERENCES "resupply"."mask_models"("id"),
  "override_variant_id" uuid
    REFERENCES "resupply"."mask_size_variants"("id"),
  "override_reason" text,

  -- ── Downstream outcome (closes the loop for later evidence work). ──
  "ordered_mask_model_id" uuid REFERENCES "resupply"."mask_models"("id"),
  "ordered_variant_id" uuid
    REFERENCES "resupply"."mask_size_variants"("id"),
  "shop_order_id" text
    REFERENCES "resupply"."shop_orders"("id") ON DELETE SET NULL,
  "dispensed_at" timestamp with time zone,

  "report_generated_at" timestamp with time zone,
  "report_count" integer NOT NULL DEFAULT 0,
  "report_link_version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "fit_sessions_entry_point_chk"
    CHECK ("entry_point" IN ('remote_link', 'in_office', 'kiosk_qr')),
  CONSTRAINT "fit_sessions_population_chk"
    CHECK ("population" IN ('adult', 'pediatric')),
  CONSTRAINT "fit_sessions_service_line_chk"
    CHECK ("service_line" IN ('pap', 'niv')),
  CONSTRAINT "fit_sessions_status_chk"
    CHECK ("status" IN (
      'in_progress', 'recommended', 'awaiting_review',
      'approved', 'overridden', 'rescan_required', 'abandoned'
    )),
  CONSTRAINT "fit_sessions_scan_quality_grade_chk"
    CHECK ("scan_quality_grade" IS NULL
           OR "scan_quality_grade" IN ('good', 'marginal', 'poor')),
  CONSTRAINT "fit_sessions_measurement_band_chk"
    CHECK ("measurement_confidence_band" IS NULL
           OR "measurement_confidence_band" IN ('high', 'moderate', 'low')),
  CONSTRAINT "fit_sessions_outcome_chk"
    CHECK ("outcome" IS NULL OR "outcome" IN (
      'high_confidence', 'moderate_confidence', 'low_confidence',
      'contraindicated', 'outside_validated_range'
    )),
  CONSTRAINT "fit_sessions_review_status_chk"
    CHECK ("review_status" IN (
      'not_required', 'pending_review', 'approved',
      'overridden', 'rescan_requested', 'rejected'
    )),
  CONSTRAINT "fit_sessions_frame_count_chk"
    CHECK ("frame_count" >= 1),
  -- An override must say why. A recommendation a clinician silently
  -- replaced is exactly the thing the report exists to prevent.
  CONSTRAINT "fit_sessions_override_reason_chk"
    CHECK ("review_status" <> 'overridden'
           OR ("override_reason" IS NOT NULL
               AND length(btrim("override_reason")) > 0))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "fit_sessions_org_created_idx"
  ON "resupply"."fit_sessions" ("org_id", "created_at" DESC);
--> statement-breakpoint

-- The RT review queue.
CREATE INDEX IF NOT EXISTS "fit_sessions_org_review_idx"
  ON "resupply"."fit_sessions"
     ("org_id", "review_status", "created_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "fit_sessions_org_patient_idx"
  ON "resupply"."fit_sessions" ("org_id", "patient_id", "created_at" DESC)
  WHERE "patient_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "fit_sessions_invite_idx"
  ON "resupply"."fit_sessions" ("fitter_invite_id")
  WHERE "fitter_invite_id" IS NOT NULL;
--> statement-breakpoint

-- Outcome analytics: how a given mask performs across a tenant.
CREATE INDEX IF NOT EXISTS "fit_sessions_org_primary_model_idx"
  ON "resupply"."fit_sessions" ("org_id", "primary_mask_model_id")
  WHERE "primary_mask_model_id" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- fit_session_events — append-only provenance trail.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply"."fit_session_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  "fit_session_id" uuid NOT NULL
    REFERENCES "resupply"."fit_sessions"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "actor_kind" text NOT NULL DEFAULT 'system',
  "actor_user_id" uuid,
  "actor_email" text,
  -- Zod-validated on write: ids, codes, counts. Never free-text PHI.
  "detail" jsonb,
  "occurred_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "fit_session_events_event_type_chk"
    CHECK ("event_type" IN (
      'session.started', 'scan.attempted', 'scan.accepted',
      'scan.rejected', 'profile.completed', 'safety.screened',
      'recommendation.generated', 'review.requested',
      'clinician.approved', 'clinician.overridden',
      'rescan.requested', 'report.generated', 'report.downloaded',
      'order.placed', 'dispensed'
    )),
  CONSTRAINT "fit_session_events_actor_kind_chk"
    CHECK ("actor_kind" IN ('patient', 'staff', 'system'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "fit_session_events_session_idx"
  ON "resupply"."fit_session_events"
     ("org_id", "fit_session_id", "occurred_at");
--> statement-breakpoint

-- ---------------------------------------------------------------
-- fit_session_safety_responses
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply"."fit_session_safety_responses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  "fit_session_id" uuid NOT NULL
    REFERENCES "resupply"."fit_sessions"("id") ON DELETE CASCADE,
  "screen_version" text NOT NULL,
  "question_key" text NOT NULL,
  "subject" text NOT NULL,
  -- 'unsure' is treated as 'yes' for exclusion purposes. Screening for
  -- an implanted device is the one place where the safe default is to
  -- assume the risk is present.
  "answer" text NOT NULL,
  "answered_at" timestamp with time zone NOT NULL DEFAULT now(),
  "acknowledged_by_email" text,
  "acknowledged_at" timestamp with time zone,
  CONSTRAINT "fit_session_safety_responses_subject_chk"
    CHECK ("subject" IN ('patient', 'household')),
  CONSTRAINT "fit_session_safety_responses_answer_chk"
    CHECK ("answer" IN ('yes', 'no', 'unsure'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "fit_session_safety_responses_uniq_idx"
  ON "resupply"."fit_session_safety_responses"
     ("org_id", "fit_session_id", "screen_version",
      "question_key", "subject");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "fit_session_safety_responses_session_idx"
  ON "resupply"."fit_session_safety_responses"
     ("org_id", "fit_session_id");
--> statement-breakpoint

-- ---------------------------------------------------------------
-- Link the fitting record back into the existing surfaces.
-- ---------------------------------------------------------------
-- Additive + nullable, so every existing row stays valid and every
-- existing query is unaffected. The legacy columns keep being written.
ALTER TABLE "resupply"."fitter_invites"
  ADD COLUMN IF NOT EXISTS "fit_session_id" uuid
  REFERENCES "resupply"."fit_sessions"("id") ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "fitter_invites_fit_session_idx"
  ON "resupply"."fitter_invites" ("fit_session_id")
  WHERE "fit_session_id" IS NOT NULL;
--> statement-breakpoint

-- mask_fit_outcomes gets the structured catalog references alongside the
-- legacy text `mask_id` (0203), which keeps being dual-written so
-- computeFitAdjustments() carries on working untouched.
ALTER TABLE "resupply"."mask_fit_outcomes"
  ADD COLUMN IF NOT EXISTS "fit_session_id" uuid
  REFERENCES "resupply"."fit_sessions"("id") ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "resupply"."mask_fit_outcomes"
  ADD COLUMN IF NOT EXISTS "mask_model_id" uuid
  REFERENCES "resupply"."mask_models"("id") ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "resupply"."mask_fit_outcomes"
  ADD COLUMN IF NOT EXISTS "size_variant_id" uuid
  REFERENCES "resupply"."mask_size_variants"("id") ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "mask_fit_outcomes_model_idx"
  ON "resupply"."mask_fit_outcomes" ("mask_model_id")
  WHERE "mask_model_id" IS NOT NULL;
