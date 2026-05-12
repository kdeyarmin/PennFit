-- Telehealth meeting URL on appointment_requests. CSRs paste a Zoom
-- / Google Meet / Doxy.me link when they confirm a tele-visit; the
-- patient-facing email and SMS reminders read this column.

ALTER TABLE "resupply"."appointment_requests"
  ADD COLUMN IF NOT EXISTS "meeting_url" text;

ALTER TABLE "resupply"."appointment_requests"
  ADD COLUMN IF NOT EXISTS "meeting_provider" varchar(32);
