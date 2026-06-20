-- 0395_reminder_escalation_voice_flag — Control Center toggle for the
-- AUTOMATED VOICE tier of the resupply-reminder escalation ladder.
--
-- Adds the `reminder_escalation.voice` feature flag. The daily escalation
-- sweep (`reminders.escalation-scan`, gated by the existing
-- `reminder_escalation.dispatcher` flag) walks an unanswered episode up a
-- channel ladder: SMS → email → (now) an automated AI phone call, before
-- finally raising a CSR "no_response" alert for a human to call.
--
-- When this flag is ENABLED for a tenant AND the voice path is configured
-- (OPENAI_API_KEY + TWILIO_ACCOUNT_SID/_AUTH_TOKEN/_PHONE_NUMBER +
-- RESUPPLY_VOICE_PUBLIC_BASE_URL), "voice" is appended to that tenant's
-- escalation ladder: an episode still unanswered ~3 days after the email
-- touch gets an automated outbound resupply check-in call placed by the
-- `reminders.place-call` worker job (the same AI agent an admin reaches via
-- the "Call" button on a patient), inside the patient's 9am–8pm local
-- quiet-hours window. If the call also goes unanswered, the ladder hands off
-- to the CSR alert exactly as before.
--
-- Seeded DISABLED, like email.auto_reply (migration 0250). Placing an
-- automated outbound call is the most intrusive (and most regulated — TCPA)
-- touch in the ladder, and it costs real per-minute voice + model spend, so
-- it must be an explicit opt-in: a tenant owner turns it on from Control
-- Center once they're comfortable letting the agent call patients. When OFF
-- (or when the voice path is unconfigured) the ladder stays SMS → email →
-- CSR alert — the exact pre-0394 behavior — so a single-tenant deploy that
-- never flips this is completely unchanged. INSERT … ON CONFLICT DO NOTHING
-- keeps re-runs idempotent and never clobbers an admin's intentional toggle.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.
-- Keep in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts.
--
-- feature_flags is PER-TENANT since migration 0350 (PK re-keyed from (key)
-- to (org_id, key)), so seed one row per organization and conflict on
-- (org_id, key) — a bare ON CONFLICT (key) no longer matches a constraint.

INSERT INTO resupply.feature_flags ("org_id", "key", "enabled", "description", "category")
SELECT o."id", v."key", v."enabled", v."description", v."category"
FROM "resupply"."organizations" o
CROSS JOIN (VALUES
  ('reminder_escalation.voice', false, 'Automated phone-call tier for the resupply-reminder escalation ladder. When ON (and the voice path is configured), an episode still unanswered after the SMS and email reminders gets an automated AI resupply check-in call before the ladder raises a CSR "call them" alert. Placed inside the patient''s local 9am–8pm window. When OFF, the ladder is SMS → email → CSR alert.', 'Voice & AI')
) AS v("key", "enabled", "description", "category")
ON CONFLICT ("org_id", "key") DO NOTHING;
