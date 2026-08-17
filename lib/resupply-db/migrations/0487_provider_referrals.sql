-- 0487_provider_referrals — the provider referral portal.
--
-- Why
-- ---
-- A referring clinician — a sleep lab, a pulmonologist, a physician's
-- office — has no way to hand a patient to a DME through this system. The
-- provider portal today can do two things: sign documents a DME staged for
-- them (0253/0297), and view RTM adherence for patients already on service.
-- Both start AFTER the DME already has the patient. Getting the patient TO
-- the DME is still a fax.
--
-- This adds the missing front half: a referring provider creates the
-- patient, sends the fitting link, reviews the recommendation, approves the
-- mask, attaches the paperwork, routes it to a DME, and then watches the
-- status and messages the DME — without a phone call or a fax.
--
-- WHAT THIS IS NOT
-- ----------------
-- This is deliberately NOT a revival of the inbound-referral subsystem that
-- migration 0295 dropped end to end (Parachute + EHR-FHIR webhooks, the
-- per-source dispatchers, the clinician share-token portal). That was a
-- machine-to-machine ingestion pipeline. This is a human-facing portal
-- built on the authenticated, MFA-gated provider identity that already
-- exists, and it introduces no inbound webhook surface.
--
-- NEIGHBOURS WITH SIMILAR NAMES — read this before assuming a duplicate
-- --------------------------------------------------------------------
-- Four tables in this schema have "referral" in the name and only two of
-- them are about the same thing:
--
--   * `referral_reviews` (0321) IS the same business event arriving by a
--     different door: a new-patient referral packet that came in as a fax
--     or a staff PDF upload, run through the AI extractor for a human to
--     confirm. `referrals` (here) is that same event arriving through the
--     front door instead — typed by an authenticated referring provider,
--     so there is nothing to OCR and nothing to confirm. They are two
--     intake channels for one concept, kept separate because their data
--     is genuinely different in kind: one is a structured submission, the
--     other is a low-confidence extraction awaiting review. If a future
--     pass unifies them, `referral_reviews` should feed `referrals` on
--     confirmation rather than either table absorbing the other.
--   * `referral_source_activity` (0431) is marketing CRM — which
--     practices send business and how much of it. Unrelated.
--   * `patient_referrals` (0107) is patient-to-patient word-of-mouth
--     attribution. Entirely unrelated despite the name.
--
-- Model
-- -----
--   provider_dme_links   — which DMEs a provider may refer to
--   referrals            — one per patient handed to a DME
--   referral_documents   — Rx, sleep study, demographics, insurance, notes
--   referral_messages    — the secure thread between provider and DME
--   referral_events      — the status timeline the portal renders
--
-- TENANCY — the important bit
-- ---------------------------
-- `providers`, `provider_portal_accounts`, and `provider_mfa_*` are
-- deliberately NOT org-scoped; migration 0342 records the reason: "providers
-- are cross-org global directory rows." That is exactly right for a
-- referral portal, because one physician refers to several DMEs.
--
-- So the two sides are scoped differently, on purpose:
--   * `provider_dme_links` is the AUTHORIZATION edge and is org-scoped —
--     a DME grants a provider the right to refer to it. Without a link a
--     provider cannot direct a referral at that DME, which is what stops
--     the global provider directory from becoming a way to push
--     unsolicited PHI into any tenant.
--   * `referrals` and its children are org-scoped to the RECEIVING DME.
--     The provider sees their own referrals across DMEs by joining on
--     `provider_id`; the DME sees only its own by `org_id`.
--
-- `routed_to_location_id` picks the branch WITHIN the receiving DME, so
-- "route to the appropriate DME" works at both granularities.
--
-- PHI
-- ---
-- `referrals` carries patient demographics typed by the provider BEFORE a
-- chart exists (that is the point — the DME does not have the patient
-- yet), plus insurance identifiers. `referral_documents` points at
-- Supabase Storage objects that are prescriptions and sleep studies.
-- `referral_messages.body` is free text between two clinical parties.
-- All three are PHI and governed by the same service-role boundary as the
-- rest of resupply.*. Log lines carry ids and counts only — never the
-- message body, never a document's contents, never the demographics.
--
-- Per ADR 003 — versioned hand-authored migration. Tenant-scoped via
-- org_id (auto-tagged by the org-scoped Supabase client on every insert).

-- ---------------------------------------------------------------
-- provider_dme_links — which DMEs a provider may refer to.
-- ---------------------------------------------------------------
-- The authorization edge between the global provider directory and a
-- tenant. Created by the DME (staff invite the provider), so a provider
-- can never unilaterally direct a referral at a tenant that has not
-- accepted them.
CREATE TABLE IF NOT EXISTS "resupply"."provider_dme_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  "provider_id" uuid NOT NULL
    REFERENCES "resupply"."providers"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'active',
  -- What this DME wants to be called in the provider's destination
  -- picker. Falls back to the organization name when NULL.
  "display_name" text,
  -- Default branch for referrals routed here, when the DME runs several.
  "default_location_id" uuid
    REFERENCES "resupply"."locations"("id") ON DELETE SET NULL,
  "invited_by_email" text,
  "invited_at" timestamp with time zone NOT NULL DEFAULT now(),
  "revoked_at" timestamp with time zone,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "provider_dme_links_status_chk"
    CHECK ("status" IN ('active', 'suspended', 'revoked'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "provider_dme_links_org_provider_idx"
  ON "resupply"."provider_dme_links" ("org_id", "provider_id");
--> statement-breakpoint

-- The provider's own destination picker: every DME this provider may
-- refer to, across tenants. Intentionally NOT led by org_id — this is the
-- one query that reads across tenants, and it is keyed by the provider's
-- own identity.
CREATE INDEX IF NOT EXISTS "provider_dme_links_provider_idx"
  ON "resupply"."provider_dme_links" ("provider_id", "status");
--> statement-breakpoint

-- ---------------------------------------------------------------
-- referrals
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply"."referrals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- The RECEIVING DME.
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  "provider_id" uuid NOT NULL
    REFERENCES "resupply"."providers"("id") ON DELETE CASCADE,
  -- Which portal account actually created it (a practice may later have
  -- several accounts per provider).
  "created_by_account_id" uuid
    REFERENCES "resupply"."provider_portal_accounts"("id") ON DELETE SET NULL,
  "created_by_email" text,

  -- Branch within the receiving DME. NULL = the DME triages it.
  "routed_to_location_id" uuid
    REFERENCES "resupply"."locations"("id") ON DELETE SET NULL,

  -- ── The patient. ──
  -- patient_id is NULL until the DME accepts the referral and either
  -- matches it to an existing chart or builds a new one. Until then the
  -- snapshot below IS the patient record, because the receiving DME does
  -- not have one yet — that is the whole point of a referral.
  "patient_id" uuid
    REFERENCES "resupply"."patients"("id") ON DELETE SET NULL,
  "patient_first_name" text NOT NULL,
  "patient_last_name" text NOT NULL,
  "patient_dob" date,
  "patient_email" text,
  "patient_phone_e164" text,
  "patient_sex" text,
  "patient_address" jsonb,
  "insurance_payer_name" text,
  "insurance_member_id" text,
  "insurance_group_number" text,

  -- ── The fitting. ──
  "fitter_invite_id" uuid
    REFERENCES "resupply"."fitter_invites"("id") ON DELETE SET NULL,
  "fit_session_id" uuid
    REFERENCES "resupply"."fit_sessions"("id") ON DELETE SET NULL,
  -- How the patient was put in front of the fitter.
  "entry_point" text NOT NULL DEFAULT 'remote_link',
  "fitting_sent_at" timestamp with time zone,
  "fitting_completed_at" timestamp with time zone,

  -- ── The provider's clinical decision. ──
  "approved_mask_model_id" uuid
    REFERENCES "resupply"."mask_models"("id") ON DELETE SET NULL,
  "approved_variant_id" uuid
    REFERENCES "resupply"."mask_size_variants"("id") ON DELETE SET NULL,
  -- Set when the provider approves something other than the engine's
  -- primary recommendation. Required by a CHECK in that case: a clinician
  -- overriding an automated recommendation has to say why, exactly as on
  -- fit_sessions.
  "approval_is_override" boolean NOT NULL DEFAULT false,
  "approval_note" text,
  "approved_at" timestamp with time zone,

  -- ── Therapy context the provider supplies. ──
  "therapy_mode" text NOT NULL DEFAULT 'pap',
  "prescribed_pressure_cm_h2o" numeric(4, 1),
  "diagnosis_code" text,
  "clinical_notes" text,

  -- ── Signature + lifecycle. ──
  "signature_request_id" uuid,
  "signed_at" timestamp with time zone,
  "status" text NOT NULL DEFAULT 'draft',
  "submitted_at" timestamp with time zone,
  "accepted_at" timestamp with time zone,
  "accepted_by_email" text,
  "declined_at" timestamp with time zone,
  "declined_reason" text,
  "dispensed_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,

  -- Whether the provider has authorized the DME to send setup and
  -- adherence updates back. Default FALSE: a disclosure back to a
  -- referring provider is opt-in, not assumed.
  "adherence_updates_authorized" boolean NOT NULL DEFAULT false,

  -- Unread counters so each side's list can show a badge without
  -- aggregating the message table on every page load.
  "provider_unread_count" integer NOT NULL DEFAULT 0,
  "dme_unread_count" integer NOT NULL DEFAULT 0,

  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "referrals_entry_point_chk"
    CHECK ("entry_point" IN ('remote_link', 'in_office', 'kiosk_qr')),
  CONSTRAINT "referrals_therapy_mode_chk"
    CHECK ("therapy_mode" IN ('pap', 'niv')),
  CONSTRAINT "referrals_status_chk"
    CHECK ("status" IN (
      'draft',            -- provider is still filling it in
      'awaiting_fitting', -- fitting link sent, patient hasn't finished
      'fitting_complete', -- recommendation is back, awaiting provider review
      'awaiting_signature',
      'signed',
      'submitted',        -- routed to the DME
      'accepted',         -- DME took it
      'in_progress',      -- DME is working it
      'dispensed',
      'declined',
      'cancelled'
    )),
  CONSTRAINT "referrals_patient_name_chk"
    CHECK (length(btrim("patient_first_name")) > 0
           AND length(btrim("patient_last_name")) > 0),
  -- A clinician overriding the automated recommendation must say why.
  CONSTRAINT "referrals_override_note_chk"
    CHECK ("approval_is_override" = false
           OR ("approval_note" IS NOT NULL
               AND length(btrim("approval_note")) > 0)),
  -- A decline must carry a reason the provider can actually read.
  CONSTRAINT "referrals_declined_reason_chk"
    CHECK ("status" <> 'declined'
           OR ("declined_reason" IS NOT NULL
               AND length(btrim("declined_reason")) > 0)),
  CONSTRAINT "referrals_unread_nonneg_chk"
    CHECK ("provider_unread_count" >= 0 AND "dme_unread_count" >= 0)
);
--> statement-breakpoint

-- The DME's inbound queue.
CREATE INDEX IF NOT EXISTS "referrals_org_status_idx"
  ON "resupply"."referrals" ("org_id", "status", "created_at" DESC);
--> statement-breakpoint

-- The provider's own list, across every DME they refer to.
CREATE INDEX IF NOT EXISTS "referrals_provider_idx"
  ON "resupply"."referrals" ("provider_id", "created_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "referrals_org_patient_idx"
  ON "resupply"."referrals" ("org_id", "patient_id")
  WHERE "patient_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "referrals_fit_session_idx"
  ON "resupply"."referrals" ("fit_session_id")
  WHERE "fit_session_id" IS NOT NULL;
--> statement-breakpoint

-- Resolving the referral when a fitting completes.
CREATE INDEX IF NOT EXISTS "referrals_fitter_invite_idx"
  ON "resupply"."referrals" ("fitter_invite_id")
  WHERE "fitter_invite_id" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- referral_documents
-- ---------------------------------------------------------------
-- The paperwork a DME needs before it can bill: prescription, sleep
-- study, demographics, insurance card, chart notes. Bytes live in
-- Supabase Storage (SUPABASE_STORAGE_BUCKET_PRIVATE) with per-object ACL
-- in resupply.object_storage_acls, exactly like POD photos and MMS media.
-- Only the pointer and the metadata live here.
CREATE TABLE IF NOT EXISTS "resupply"."referral_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  "referral_id" uuid NOT NULL
    REFERENCES "resupply"."referrals"("id") ON DELETE CASCADE,
  "doc_type" text NOT NULL,
  "file_name" text NOT NULL,
  "storage_object_path" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "uploaded_by_kind" text NOT NULL DEFAULT 'provider',
  "uploaded_by_email" text,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "referral_documents_doc_type_chk"
    CHECK ("doc_type" IN (
      'prescription', 'sleep_study', 'demographics', 'insurance',
      'chart_note', 'face_sheet', 'other'
    )),
  CONSTRAINT "referral_documents_uploaded_by_kind_chk"
    CHECK ("uploaded_by_kind" IN ('provider', 'staff')),
  CONSTRAINT "referral_documents_size_chk"
    CHECK ("size_bytes" > 0 AND "size_bytes" <= 26214400)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "referral_documents_referral_idx"
  ON "resupply"."referral_documents" ("org_id", "referral_id", "created_at");
--> statement-breakpoint

-- ---------------------------------------------------------------
-- referral_messages
-- ---------------------------------------------------------------
-- The secure thread that replaces the phone call. Deliberately its own
-- table rather than a row in `conversations`: that subsystem models a
-- PATIENT channel (SMS/email threads with keyword routing, consent, and
-- opt-out semantics), and a clinician-to-DME thread shares none of that.
CREATE TABLE IF NOT EXISTS "resupply"."referral_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  "referral_id" uuid NOT NULL
    REFERENCES "resupply"."referrals"("id") ON DELETE CASCADE,
  "author_kind" text NOT NULL,
  "author_email" text,
  "author_name" text,
  "body" text NOT NULL,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "referral_messages_author_kind_chk"
    CHECK ("author_kind" IN ('provider', 'staff')),
  CONSTRAINT "referral_messages_body_chk"
    CHECK (length(btrim("body")) > 0 AND length("body") <= 8000)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "referral_messages_thread_idx"
  ON "resupply"."referral_messages" ("org_id", "referral_id", "created_at");
--> statement-breakpoint

-- ---------------------------------------------------------------
-- referral_events
-- ---------------------------------------------------------------
-- The status timeline. This is what makes "see referral status without
-- telephone calls or faxes" real: the provider reads the same event
-- stream the DME writes.
--
-- Like fit_session_events (0483), this is an ordinary feature-owned
-- domain table, NOT resupply.audit_log — the repo forbids new readers or
-- writers of that retired machinery. `detail` carries ids, codes, and
-- counts only, never free-text PHI.
CREATE TABLE IF NOT EXISTS "resupply"."referral_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  "referral_id" uuid NOT NULL
    REFERENCES "resupply"."referrals"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "actor_kind" text NOT NULL DEFAULT 'system',
  "actor_email" text,
  "detail" jsonb,
  "occurred_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "referral_events_event_type_chk"
    CHECK ("event_type" IN (
      'referral.created', 'fitting.sent', 'fitting.completed',
      'mask.approved', 'document.attached', 'document.removed',
      'signature.requested', 'signature.signed', 'signature.declined',
      'referral.submitted', 'referral.accepted', 'referral.declined',
      'referral.in_progress', 'referral.dispensed', 'referral.cancelled',
      'message.sent', 'patient.matched', 'adherence.shared'
    )),
  CONSTRAINT "referral_events_actor_kind_chk"
    CHECK ("actor_kind" IN ('provider', 'staff', 'patient', 'system'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "referral_events_timeline_idx"
  ON "resupply"."referral_events" ("org_id", "referral_id", "occurred_at");
--> statement-breakpoint

-- ---------------------------------------------------------------
-- Teach the e-signature queue about referral orders.
-- ---------------------------------------------------------------
-- The provider signs a referral order through the SAME queue, signature
-- capture, ESIGN consent, and signature-log PDF that already serve
-- prescriptions and DWOs (0297). Only the subject vocabulary needs
-- widening — no second signing path, which is exactly what keeps one
-- audit trail rather than two.
--
-- Drop-and-recreate because Postgres has no ALTER CONSTRAINT for a CHECK.
-- Guarded so a re-run is a no-op.
ALTER TABLE "resupply"."provider_signature_requests"
  DROP CONSTRAINT IF EXISTS "provider_signature_requests_subject_type_chk";
--> statement-breakpoint

ALTER TABLE "resupply"."provider_signature_requests"
  ADD CONSTRAINT "provider_signature_requests_subject_type_chk"
  CHECK ("subject_type" IN (
    'prescription', 'prescription_packet', 'order', 'claim',
    'cmn', 'dwo', 'swo', 'document', 'referral'
  ));
--> statement-breakpoint

-- Back-reference from the referral to its signature request. Added after
-- the table exists so the FK target is unambiguous.
--
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS for a foreign key, and
-- every other statement in this file is re-runnable, so guard it by hand
-- rather than leaving one statement that would fail a replay.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'referrals_signature_request_fk'
      AND conrelid = 'resupply.referrals'::regclass
  ) THEN
    ALTER TABLE "resupply"."referrals"
      ADD CONSTRAINT "referrals_signature_request_fk"
      FOREIGN KEY ("signature_request_id")
      REFERENCES "resupply"."provider_signature_requests"("id")
      ON DELETE SET NULL;
  END IF;
END$$;
