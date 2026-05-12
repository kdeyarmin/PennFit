-- patient_maintenance_nudges — record of weekly hygiene nudge
-- emails. See schema/patient-maintenance-nudges.ts for the full
-- rationale (separate from the per-task completion log; supports
-- a 7-day quiet period).
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

CREATE TABLE IF NOT EXISTS "resupply"."patient_maintenance_nudges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "patient_id" uuid NOT NULL REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "sent_at" timestamp with time zone NOT NULL DEFAULT now(),
  "channel" text NOT NULL DEFAULT 'email',
  "task_keys" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "patient_maintenance_nudges_channel_enum"
    CHECK ("channel" IN ('email', 'sms'))
);

CREATE INDEX IF NOT EXISTS "patient_maintenance_nudges_patient_sent_at_idx"
  ON "resupply"."patient_maintenance_nudges" ("patient_id", "sent_at");
