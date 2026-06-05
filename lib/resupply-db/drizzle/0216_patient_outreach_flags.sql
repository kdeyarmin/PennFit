-- 0216_patient_outreach_flags — surface four env-gated patient-facing
-- automations as on/off toggles in the admin Control Center.
--
-- These features already exist and are gated by environment variables
-- that the worker reads at boot to attach a schedule / register the job:
--
--   clinical_outreach.dispatcher        CLINICAL_OUTREACH_CRON
--   eligibility.auto_reverify           ELIGIBILITY_REVERIFY_CRON
--   fitter_first_day_nudge.dispatcher   RESUPPLY_FITTER_FIRST_DAY_NUDGE_ENABLED
--   fitter_reengage.dispatcher          RESUPPLY_FITTER_REENGAGE_ENABLED
--
-- The env var still controls SCHEDULING (when / whether the cron is
-- attached). Each flag is an additional RUNTIME kill switch the job
-- checks every tick, so an operator can pause the feature from settings
-- without touching env. Same pattern as cart_abandonment.dispatcher and
-- billing.auto_submit_claims.
--
-- SEEDED ENABLED so the toggle preserves current behavior exactly: a
-- deployment that already set the env schedule keeps running (env set AND
-- flag on). Flipping a flag OFF pauses that feature; flipping it ON has
-- no effect until the env schedule is also set. ON CONFLICT DO NOTHING
-- preserves any operator choice already on file.
--
-- Per ADR 003 — versioned hand-authored migration.

INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('clinical_outreach.dispatcher',
   true,
   'Proactive clinical outreach: templated, consent/DND/frequency-cap-gated nudges to patients with an open non-adherence intervention. Scheduling is controlled by CLINICAL_OUTREACH_CRON; turning this OFF pauses the sends without changing the schedule. The admin "Run now" trigger is unaffected.',
   'Messaging'),
  ('eligibility.auto_reverify',
   true,
   'Scheduled eligibility re-verification: fires fresh 270s for the most-urgent active coverages (throttled + capped per run). Scheduling is controlled by ELIGIBILITY_REVERIFY_CRON; turning this OFF pauses the unattended 270s without changing the schedule. The admin "Run batch now" trigger is unaffected.',
   'Billing'),
  ('fitter_first_day_nudge.dispatcher',
   true,
   'Fitter lead first-day nudge: a one-time email/SMS to new fitter leads on day one. Registration is gated by RESUPPLY_FITTER_FIRST_DAY_NUDGE_ENABLED; turning this OFF pauses the sweep without changing that env gate.',
   'Messaging'),
  ('fitter_reengage.dispatcher',
   true,
   'Fitter lead re-engagement: follow-up outreach to fitter leads who have gone quiet. Registration is gated by RESUPPLY_FITTER_REENGAGE_ENABLED; turning this OFF pauses the sweep without changing that env gate.',
   'Messaging')
ON CONFLICT (key) DO NOTHING;
