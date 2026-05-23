-- 0149_feature_flags — Admin Control Center.
--
-- Persists boolean on/off toggles for major application features so
-- admins can disable them from the UI without a deploy. Used by
-- dispatchers, route handlers, and worker jobs that consult
-- `isFeatureEnabled(key)` before doing work.
--
-- Design notes
-- ------------
--   * One row per feature, keyed by a short slug (`sms.reminders`,
--     `voice.agent`, `bulk_campaigns.send`, etc.). The slug is the
--     code-level constant; the row is the runtime state.
--   * Defaults to enabled — flipping a flag OFF is the explicit
--     opt-out. A fresh database boots with every feature on, matching
--     the pre-control-center behavior.
--   * `updated_by_user_id` is a free-form text so it survives if the
--     admin row is later deleted, matching the audit-log posture.
--   * No FK to `auth.users(id)` for the same reason — the audit_log
--     row carries the canonical actor trail; this column is just for
--     "who last touched this row" display in the admin UI.
--
-- What this does NOT do
-- ---------------------
--   * No gradual rollout (percentages, allowlists, A/B). Boolean only.
--     If we need finer-grained gating later, that's a follow-up.
--   * No "feature dependencies" graph. If turning off A breaks B,
--     the code that consults the flag is responsible for documenting
--     the relationship; we don't enforce it at the table level.
--   * No PHI. Flag keys are static constants; metadata is
--     description/category strings.

CREATE TABLE IF NOT EXISTS resupply.feature_flags (
  key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  description text NOT NULL,
  category text NOT NULL,
  -- The auth user id of whoever last toggled this row. Nullable
  -- because seed rows have no actor. Text not uuid so a deleted
  -- admin row doesn't break the FK.
  updated_by_user_id text NULL,
  updated_by_email text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint

-- Index on category so the admin Control Center UI can group
-- toggles without a sequential scan. The table is tiny (< 100 rows
-- expected ever) so this is mostly belt-and-braces.
CREATE INDEX IF NOT EXISTS feature_flags_category_idx
  ON resupply.feature_flags (category);

--> statement-breakpoint

-- Seed the catalog. INSERT … ON CONFLICT DO NOTHING so re-runs are
-- idempotent and don't clobber an admin's intentional disable.
-- Keep this list in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts.
INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('sms.reminders',
   true,
   'Outbound SMS resupply reminders (90/30-day reorder nudges). Disabling stops the reminder dispatcher from sending new SMS.',
   'Messaging'),
  ('email.reminders',
   true,
   'Outbound email resupply reminders. Disabling stops the reminder dispatcher from sending new email.',
   'Messaging'),
  ('voice.agent',
   true,
   'Inbound voice agent (OpenAI Realtime). Disabling returns a 503 / hangup TwiML to any inbound call.',
   'Voice & AI'),
  ('storefront.chatbot',
   true,
   'Storefront chat assistant (Claude Sonnet / GPT fallback). Disabling makes the chat widget return a friendly "currently offline" message.',
   'Voice & AI'),
  ('storefront.checkout',
   true,
   'Allow new Stripe Checkout sessions from the patient storefront. Disabling returns a 503 from the create-session endpoint; existing carts and orders are unaffected.',
   'Storefront'),
  ('storefront.reviews_collection',
   true,
   'Post-delivery review-request emails. Disabling stops new review-request emails; previously-sent ones still accept submissions.',
   'Storefront'),
  ('storefront.nps',
   true,
   'Post-delivery NPS survey emails. Disabling stops new NPS sends; previously-sent surveys still record responses.',
   'Storefront'),
  ('bulk_campaigns.send',
   true,
   'Sending of bulk-messaging campaigns to opted-in patients. Disabling stops the bulk-campaign worker from sending new messages.',
   'Messaging'),
  ('cart_abandonment.dispatcher',
   true,
   'Cart-abandonment nudge emails. Disabling stops the dispatcher from sending new nudges to patients with abandoned carts.',
   'Storefront'),
  ('ai_billing.suggestions',
   true,
   'AI-assisted billing claim suggestions in the billing AI queue. Disabling returns suggestions as "AI offline"; manual workflow is unaffected.',
   'Billing'),
  ('smart_triggers.dispatcher',
   true,
   'Smart-trigger reorder dispatcher (therapy-night patterns). Disabling stops the dispatcher from queueing new reminders.',
   'Messaging'),
  ('patient_onboarding.dispatcher',
   true,
   'First-90-day adherence-coaching nudges. Disabling stops the onboarding dispatcher from sending day-1/7/30/90 messages.',
   'Messaging')
ON CONFLICT (key) DO NOTHING;
