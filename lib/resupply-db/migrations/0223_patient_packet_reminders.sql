-- Patient signature packet reminders.
--
-- Adds per-packet reminder bookkeeping so a scheduled worker can re-send
-- the signing link (email/SMS) to patients who have not yet completed
-- their packet, without nagging them more often than configured.
--
--   reminder_count    — how many reminder nudges we've sent (0 = none)
--   last_reminded_at  — when we last nudged (NULL until the first one)
--
-- Plus the admin-flippable toggle that gates the reminder sweep. Seeded
-- OFF so enabling automated patient outreach is a deliberate opt-in.

ALTER TABLE "resupply"."patient_packets"
  ADD COLUMN IF NOT EXISTS "reminder_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_reminded_at" timestamptz;

INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('patient_packets.autoremind',
   false,
   'Automatically re-send the signing link to patients who have not finished their document packet, on a fixed cadence with a maximum number of nudges. The sweep runs daily (override with PATIENT_PACKET_REMINDER_CRON); turning this OFF pauses the sends without changing the schedule. OFF by default.',
   'Messaging')
ON CONFLICT (key) DO NOTHING;
