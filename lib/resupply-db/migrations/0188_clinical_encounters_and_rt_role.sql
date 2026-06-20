-- 0188_clinical_encounters_and_rt_role — Phase 0 / F3: clinical encounter
-- documentation + the respiratory-therapist (rt) role.
--
-- Why this exists
-- ---------------
-- The single biggest missing primitive on the roadmap (F3): there is no
-- surface for a clinician to DOCUMENT a patient interaction. The only
-- "notes" today are supervisor→CSR coaching notes. This adds the store —
-- resupply.clinical_encounters — that the intervention plan, mask-fit
-- feedback loop, and per-RT outcomes all build on, plus the `rt` granular
-- role the clinician portal gates on.
--
-- What lands here
-- ---------------
--   * Adds 'rt' to the admin_users.role CHECK (it was last set to the
--     7-role set in 0086). The coarse auth.users.role stays 'agent'
--     (coarseAuthRoleFor maps every non-admin role to agent), so the
--     existing staff gate admits an rt without an auth_users change. The
--     `rt` role maps to a new `clinician` effective bucket in
--     lib/resupply-auth/src/rbac.ts.
--   * resupply.clinical_encounters — append-only clinical log. Soft
--     references (no hard FK) for patient_id / linked_alert_id /
--     linked_episode_id so the log survives independent of those rows
--     and we don't couple to their key types.
--
-- Additive. Per ADR 003 — versioned hand-authored migration.

-- ---------------------------------------------------------------
-- Add 'rt' to the admin_users role enum (extends 0086's 7-role set).
-- ---------------------------------------------------------------
ALTER TABLE "resupply"."admin_users"
  DROP CONSTRAINT IF EXISTS "admin_users_role_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."admin_users"
  ADD CONSTRAINT "admin_users_role_enum"
  CHECK ("role" IN (
    'admin',
    'supervisor',
    'csr',
    'fitter',
    'fulfillment',
    'compliance_officer',
    'agent',
    'rt'
  ));
--> statement-breakpoint

-- ---------------------------------------------------------------
-- clinical_encounters — append-only clinician documentation.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply"."clinical_encounters" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid()::text) NOT NULL,
  -- Soft reference to the patient (no FK — append-only log; avoids
  -- coupling to the patients PK type).
  "patient_id" text NOT NULL,
  -- The authoring staff member (auth user id) + a stable email label so
  -- the record reads cleanly even after an ex-employee row is gone.
  "author_user_id" text,
  "author_email" text NOT NULL,
  "encounter_type" text NOT NULL,
  -- Structured clinical fields — all optional; an encounter may be just
  -- a free-text note.
  "reason" text,
  "assessment" text,
  "intervention" text,
  "plan" text,
  "follow_up_at" timestamp with time zone,
  "note" text,
  -- Optional links to what prompted the encounter (soft refs).
  "linked_alert_id" text,
  "linked_episode_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "resupply"."clinical_encounters"
  DROP CONSTRAINT IF EXISTS "clinical_encounters_type_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."clinical_encounters"
  ADD CONSTRAINT "clinical_encounters_type_enum"
  CHECK ("encounter_type" IN (
    'mask_fit',
    'troubleshoot',
    'setup_education',
    'adherence_intervention',
    'phone',
    'other'
  ));
--> statement-breakpoint

-- Patient clinical timeline: newest-first per patient.
CREATE INDEX IF NOT EXISTS "clinical_encounters_patient_created_idx"
  ON "resupply"."clinical_encounters" ("patient_id", "created_at" DESC);
--> statement-breakpoint

ALTER TABLE "resupply"."clinical_encounters" ENABLE ROW LEVEL SECURITY;
