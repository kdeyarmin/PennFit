-- 0173_reminder_escalation_flag — feature flag for the multi-channel
-- reminder escalation job (#7).
--
-- The hourly reminders.scan does the first touch on one channel. The
-- new daily reminders.escalation-scan follows up unanswered episodes
-- on the next channel (sms → email), then raises a CSR "call them"
-- alert once both channels are exhausted.
--
-- SEEDED DISABLED: escalation adds a second outbound message per
-- unanswered episode (a real per-message cost), so production starts
-- with it OFF and an operator turns it on from the Control Center.
-- (Dev/preview environments without a reachable Supabase read every
-- flag as enabled; that's fine — the job only acts on aged, unanswered
-- episodes, so it's a no-op without that data.)
--
-- Per ADR 003 — versioned hand-authored migration.

INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('reminder_escalation.dispatcher',
   false,
   'Daily multi-channel escalation for unanswered resupply reminders: follow up on the next channel (SMS then email) ~3 days after the first touch, then raise a CSR call alert once both channels are exhausted. Disabled keeps reminders to the single first-touch channel.',
   'Messaging')
ON CONFLICT (key) DO NOTHING;
