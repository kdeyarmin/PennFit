-- 0248_email_auto_reply_flag — Control Center toggle for chatbot email
-- auto-replies.
--
-- Adds the `email.auto_reply` feature flag. When ENABLED (and an LLM
-- provider key is configured), the SendGrid Inbound Parse webhook
-- (`/email/inbound-parse`) drafts a reply to an inbound patient email
-- with the storefront chatbot knowledge base and sends it back by email,
-- instead of only filing the message for a human. The model hands off any
-- order/account/clinical-specific or low-confidence message, so a teammate
-- still picks those up via the awaiting_admin queue.
--
-- Seeded DISABLED, unlike the other flags. This is a deliberate change to
-- the historical behavior (ADR 013 — "no inbound email parser; free-text
-- replies go to a human"), so it must be an explicit opt-in: an admin
-- turns it on from the Control Center once they're comfortable letting the
-- assistant answer email. INSERT … ON CONFLICT DO NOTHING keeps re-runs
-- idempotent and never clobbers an admin's intentional toggle.
--
-- Keep in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts.

INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('email.auto_reply',
   false,
   'Chatbot email auto-replies. When ON, inbound patient emails are answered automatically by the storefront chat assistant (Claude Sonnet / GPT fallback); it hands off order/account/clinical or low-confidence messages to a human. When OFF, every inbound email is routed to the admin inbox for a manual reply.',
   'Voice & AI')
ON CONFLICT (key) DO NOTHING;
