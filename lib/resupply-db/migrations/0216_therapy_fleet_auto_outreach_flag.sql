-- 0216_therapy_fleet_auto_outreach_flag — seed the MISSING
-- therapy_fleet.auto_outreach feature flag so it shows up (and can be
-- toggled) in the admin Control Center.
--
-- Background
-- ----------
-- `therapy_fleet.auto_outreach` is referenced in code — it's in
-- FEATURE_FLAG_KEYS and gates patient SMS auto-outreach in two worker
-- jobs (therapy-fleet-alerts-scan, therapy-setup-deadline-outreach),
-- both documented "OFF by default". But it was never seeded into
-- resupply.feature_flags, which had two consequences:
--
--   1. The Control Center reads SEEDED rows, so the flag never appeared
--      there — an operator had no way to turn it on or off from the UI,
--      and PATCH /admin/feature-flags/:key returned `flag_not_seeded`.
--   2. isFeatureEnabled() treats an unseeded key as ENABLED (the table's
--      "default on" posture), so the outreach that was meant to be OFF by
--      default was actually defaulting ON — masked only because the jobs
--      AND it with sms.reminders + Twilio config + per-patient consent/DND.
--
-- Seeding it DISABLED fixes both: the toggle appears in settings, and the
-- runtime default now matches the documented "OFF by default" intent.
-- ON CONFLICT DO NOTHING preserves any operator choice already on file.
--
-- Per ADR 003 — versioned hand-authored migration.

INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('therapy_fleet.auto_outreach',
   false,
   'Therapy-fleet adherence auto-outreach: gentle SMS nudges to consented at-risk patients from the nightly fleet-alerts scan and the setup-deadline job. Also requires sms.reminders ON and Twilio configured; per-patient consent / DND / frequency caps still apply. SEEDED DISABLED.',
   'Messaging')
ON CONFLICT (key) DO NOTHING;
