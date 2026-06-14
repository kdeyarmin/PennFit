-- 0325_enable_dormant_revenue_levers — turn ON the consent/ops-gated levers.
--
-- Three feature flags shipped seeded OFF as deliberate opt-ins. The business
-- owner has signed off on enabling them, so flip them ON here:
--
--   storefront.auto_reminder_enrollment — on a paid storefront order, auto-
--     enroll the buyer in replacement reminders (resupply revenue lever).
--   billing.auto_submit_claims          — unattended auto-submission of
--     submission-ready claims to Office Ally (cash-flow throughput).
--   email.auto_reply                    — chatbot answers inbound patient
--     email automatically, handing off order/account/clinical or low-
--     confidence messages to a human (CSR-time lever).
--
-- (cart_abandonment.dispatcher is already seeded ON in 0149 — no change.)
--
-- Uses ON CONFLICT (key) DO UPDATE so the flip is correct on BOTH a populated
-- production DB (row already exists → updated to true) and a brand-new DB
-- replaying migrations in order (earlier seed inserted false → set true here).
-- A later runtime toggle from the Control Center is not re-clobbered: this
-- migration runs once, tracked in the ledger.
--
-- Keep in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts.
--
-- Per ADR 003 — versioned hand-authored migration.

INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('storefront.auto_reminder_enrollment',
   true,
   'On a paid storefront order, auto-enroll the buyer in replacement reminders for the items purchased.',
   'Storefront'),
  ('billing.auto_submit_claims',
   true,
   'Unattended auto-submission of submission-ready claims to Office Ally on the auto-workflow cycle.',
   'Billing'),
  ('email.auto_reply',
   true,
   'Chatbot email auto-replies. When ON, inbound patient emails are answered automatically by the storefront chat assistant (Claude Sonnet / GPT fallback); it hands off order/account/clinical or low-confidence messages to a human. When OFF, every inbound email is routed to the admin inbox for a manual reply.',
   'Voice & AI')
ON CONFLICT (key) DO UPDATE SET enabled = true, updated_at = now();
