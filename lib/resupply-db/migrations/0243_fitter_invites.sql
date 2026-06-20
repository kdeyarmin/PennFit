-- 0243_fitter_invites — staff-initiated AI mask-fitter invitations.
--
-- A CSR / fitter sends a prospective or current patient a signed link
-- to run the on-device AI mask fitter. When the patient finishes, the
-- numeric facial measurements, questionnaire answers, and the mask
-- recommendation are transmitted back to PennPaps and recorded here
-- for follow-up. (Per the codebase invariant, only the NUMERIC
-- measurements travel — no images ever leave the patient's device.)
--
-- Lifecycle (status):
--   sent      — invite created + delivered (email or SMS).
--   opened    — recipient opened the link and started the fitter.
--   completed — recipient finished; measurements/answers/recommendation
--               are populated. If their email/phone matched a patient
--               on file, patient_id is set and auto_matched=true.
--   attached  — a staff member manually linked the completed fitting to
--               a patient chart (existing or newly built).
--   revoked   — staff revoked the invite before completion.
--   expired   — TTL elapsed (set lazily on resolve, never a sweep).
--
-- Auto-attach: on completion we look up resupply.patients by the
-- recipient email (then phone). A single unambiguous match links the
-- chart automatically (auto_matched=true). No match, or more than one,
-- leaves patient_id NULL for the staff worklist to resolve — either
-- attach to an existing chart or build a new one.
--
-- Plain table (no RLS) — service-role client only. PHI: facial
-- measurements + questionnaire answers + recipient contact. Governed
-- by the same service-role boundary as the rest of resupply.* and the
-- patient FK. Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."fitter_invites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Linked chart. NULL until matched (auto on completion or manual via
  -- the worklist). ON DELETE SET NULL so deleting a chart doesn't erase
  -- the fitting record (it just becomes unattached again).
  "patient_id" uuid REFERENCES "resupply"."patients"("id") ON DELETE SET NULL,
  -- Who the invite was sent to. For a current patient these mirror the
  -- chart at send time; for a prospect they're the only contact we have.
  "recipient_email" text,
  "recipient_phone_e164" text,
  "recipient_name" text,
  -- Delivery channel chosen by the sender.
  "channel" text NOT NULL,
  "status" text NOT NULL DEFAULT 'sent',
  -- Audit: which staff member sent it.
  "invited_by_user_id" uuid,
  "invited_by_email" text,
  -- Captured on completion. Measurements + answers are stored as JSON
  -- so the schema doesn't have to track every recommendation-engine
  -- field. recommendations holds the ranked top-N for follow-up.
  "measurements" jsonb,
  "questionnaire_answers" jsonb,
  "recommended_mask_id" text,
  "recommended_mask_name" text,
  "recommended_mask_type" text,
  "recommendations" jsonb,
  -- True when patient_id was set automatically by the email/phone match
  -- on completion (vs. a manual staff attach).
  "auto_matched" boolean NOT NULL DEFAULT false,
  "sent_at" timestamp with time zone,
  "opened_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "attached_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "fitter_invites_channel_chk"
    CHECK ("channel" IN ('email', 'sms')),
  CONSTRAINT "fitter_invites_status_chk"
    CHECK ("status" IN ('sent', 'opened', 'completed', 'attached', 'revoked', 'expired'))
);
--> statement-breakpoint
-- Worklist sorts/filters by status, newest first.
CREATE INDEX IF NOT EXISTS "fitter_invites_status_created_idx"
  ON "resupply"."fitter_invites" ("status", "created_at" DESC);
--> statement-breakpoint
-- Patient chart → its fittings.
CREATE INDEX IF NOT EXISTS "fitter_invites_patient_id_idx"
  ON "resupply"."fitter_invites" ("patient_id");
--> statement-breakpoint
-- Auto-attach lookup is by lowercased email.
CREATE INDEX IF NOT EXISTS "fitter_invites_recipient_email_idx"
  ON "resupply"."fitter_invites" (lower("recipient_email"));
