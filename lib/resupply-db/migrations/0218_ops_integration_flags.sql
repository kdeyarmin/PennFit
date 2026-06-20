-- 0218_ops_integration_flags — surface the last two env-only worker
-- features as on/off toggles in the admin Control Center, finishing the
-- "every feature that can be turned on/off lives in settings" goal.
--
-- Both features are gated by an env var that the worker reads at boot to
-- REGISTER (or skip) the job:
--
--   failed_email_digest.dispatcher   RESUPPLY_FAILED_EMAIL_DIGEST_ENABLED
--   inbound_referrals.dispatcher     RESUPPLY_INBOUND_REFERRALS_ENABLED
--                                    (gates 3 jobs: inbound-referral
--                                     preflight, status-outbound, and the
--                                     inbound-webhook dispatcher)
--
-- The env var still controls registration / provisioning (the inbound-
-- referral jobs only register once their tables + a partner tenant
-- exist). Each flag is an additional RUNTIME kill switch the job checks
-- every tick, so an operator can pause the feature from settings without
-- touching env. Same pattern as billing.auto_submit_claims and the four
-- patient-outreach flags (migration 0217).
--
-- SEEDED ENABLED so behavior is preserved exactly: a deployment that
-- already set the env gate keeps running (env set AND flag on). Flipping
-- a flag OFF pauses the feature; flipping it ON is a no-op until the env
-- gate is also set (the job won't even be registered). ON CONFLICT DO
-- NOTHING preserves any operator choice already on file. The flag check
-- runs inside the work handler, only reachable once registration occurred
-- — so the inbound-referrals flag never trips on missing tables.
--
-- Per ADR 003 — versioned hand-authored migration.

INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('failed_email_digest.dispatcher',
   true,
   'Daily failed-order email digest: a single summary email to the ops alerts address listing orders whose confirmation email failed in the last 24h (order reference + timestamp only — no patient PHI). Scheduling is gated by RESUPPLY_FAILED_EMAIL_DIGEST_ENABLED; turning this OFF pauses the digest without changing that env gate.',
   'Operations'),
  ('inbound_referrals.dispatcher',
   true,
   'Inbound referral / EHR-FHIR integration workers: drains the inbound_webhooks / inbound_referral_* queues (preflight checks, partner status callbacks, per-source dispatch). Registration is gated by RESUPPLY_INBOUND_REFERRALS_ENABLED (requires the inbound-referral schema + a provisioned partner tenant); turning this OFF pauses all three referral jobs without changing that env gate.',
   'Integrations')
ON CONFLICT (key) DO NOTHING;
