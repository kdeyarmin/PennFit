-- 0204_clinical_outreach_log — RT #23: proactive clinical outreach.
--
-- When an RT opens a non-adherence intervention (#21), we can reach the
-- patient with a short, supportive, templated nudge (email/SMS) tuned to
-- the assessment category. This table is BOTH the audit record of every
-- outreach attempt AND the frequency-cap source — "have we contacted this
-- patient in the last N days?" is a lookup here, so we never over-message.
--
-- Gating (consent/DND) is evaluated at send time against the patient's
-- communication preferences, mirroring the smart-trigger clinical-nudge
-- policy (DND always; marketing-channel opt-out honoured; no prefs row →
-- allowed). PHI posture: category + channel + status only — never the
-- message body or contact. Additive. Per ADR 003.

CREATE TABLE IF NOT EXISTS "resupply"."clinical_outreach_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  -- Soft ref to the clinical_encounters intervention that prompted it.
  "intervention_encounter_id" uuid,
  "channel" text NOT NULL,
  -- The assessment_category that selected the message template.
  "message_category" text,
  "status" text NOT NULL,
  "error" text,
  "sent_by_email" text NOT NULL DEFAULT 'system',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "clinical_outreach_log_channel_enum"
    CHECK ("channel" IN ('email', 'sms')),
  CONSTRAINT "clinical_outreach_log_status_enum"
    CHECK ("status" IN ('sent', 'failed', 'skipped'))
);
--> statement-breakpoint

-- Frequency cap: "most recent outreach to this patient" lookup.
CREATE INDEX IF NOT EXISTS "clinical_outreach_log_patient_created_idx"
  ON "resupply"."clinical_outreach_log" ("patient_id", "created_at" DESC);
