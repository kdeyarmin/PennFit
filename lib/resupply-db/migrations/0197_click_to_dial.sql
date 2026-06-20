-- 0197_click_to_dial — CSR #11: click-to-dial + call-back queue.
--
-- A CSR clicks "Call" on the patient panel; Twilio rings the agent's
-- own phone first, then bridges the patient in (agent-first bridge).
-- After the call the CSR logs a disposition (reached / voicemail /
-- no answer / …) + an optional note. This adds the two bits of state
-- that needs:
--
--   * admin_users.phone_e164 — the agent's bridge number. Twilio dials
--     THIS first; without it we can't place the bridge (the route 422s
--     with "set your callback number"). NULLABLE — agents opt in.
--
--   * call_dispositions — one row per call attempt. Created in
--     'initiated' the moment the dial is placed (so a failed/abandoned
--     attempt still leaves a trail), then PATCHed to the real outcome
--     when the CSR logs it. Soft refs to patient_id / conversation_id
--     (no FK — append-only log, matches clinical_encounters). The note
--     is plain text and is NEVER logged (PHI); the app logger only ever
--     sees the outcome + counts.
--
-- outcome enum:
--   initiated          — dial placed, not yet dispositioned.
--   reached            — spoke with the patient.
--   voicemail          — left / reached voicemail.
--   no_answer          — rang out.
--   busy               — line busy.
--   failed             — Twilio/carrier error placing the bridge.
--   wrong_number       — number didn't reach the patient.
--   callback_requested — patient asked us to call back later.
--
-- RLS deny-all (service-role only), additive, no backfill. Per ADR 003
-- — versioned hand-authored migration.

ALTER TABLE "resupply"."admin_users"
  ADD COLUMN IF NOT EXISTS "phone_e164" text;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "resupply"."call_dispositions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid,
  "conversation_id" uuid,
  "outcome" text NOT NULL DEFAULT 'initiated',
  "note" text,
  "twilio_call_sid" text,
  "agent_user_id" text,
  "agent_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "resupply"."call_dispositions"
  DROP CONSTRAINT IF EXISTS "call_dispositions_outcome_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."call_dispositions"
  ADD CONSTRAINT "call_dispositions_outcome_enum"
  CHECK ("outcome" IN (
    'initiated', 'reached', 'voicemail', 'no_answer',
    'busy', 'failed', 'wrong_number', 'callback_requested'
  ));
--> statement-breakpoint

-- Per-patient call history + recent-attempts scans.
CREATE INDEX IF NOT EXISTS "call_dispositions_patient_id_idx"
  ON "resupply"."call_dispositions" ("patient_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_dispositions_created_at_idx"
  ON "resupply"."call_dispositions" ("created_at" DESC);
--> statement-breakpoint

ALTER TABLE "resupply"."call_dispositions"
  ENABLE ROW LEVEL SECURITY;
