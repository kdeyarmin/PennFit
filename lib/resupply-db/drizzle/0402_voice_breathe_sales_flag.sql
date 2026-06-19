-- 0402_voice_breathe_sales_flag — Control Center toggle for the CareMetric
-- Breathe B2B platform SALES voice agent.
--
-- Adds the `voice.breathe_sales` feature flag. When ENABLED (and the voice
-- path is configured — OPENAI_API_KEY + Twilio + RESUPPLY_VOICE_PUBLIC_BASE_URL
-- + a BREATHE_SALES_VOICE_NUMBER pointed at /resupply-api/voice/inbound-breathe-sales),
-- inbound calls to the dedicated platform sales number reach the sales agent:
-- it pitches prospective DME businesses on the CareMetric Breathe platform,
-- emails them information, captures leads (resupply.sales_leads + emails the
-- super-admins), and can start a tenant sign-up on the call. When OFF, the
-- route answers with a clean hangup.
--
-- This is a PLATFORM line, not a tenant line, so the gate is checked against
-- the seed org (isFeatureEnabled("voice.breathe_sales") with no orgId).
--
-- Seeded DISABLED, like reminder_escalation.voice (0395) and email.auto_reply
-- (0250): it answers regulated phone calls and costs real per-minute voice +
-- model spend, so it must be an explicit opt-in once a sales number is wired
-- up. INSERT … ON CONFLICT DO NOTHING keeps re-runs idempotent and never
-- clobbers an intentional toggle.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.
-- Keep in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts.
--
-- feature_flags is PER-TENANT since migration 0350 (PK (org_id, key)), so seed
-- one row per organization and conflict on (org_id, key).

INSERT INTO resupply.feature_flags ("org_id", "key", "enabled", "description", "category")
SELECT o."id", v."key", v."enabled", v."description", v."category"
FROM "resupply"."organizations" o
CROSS JOIN (VALUES
  ('voice.breathe_sales', false, 'CareMetric Breathe B2B platform sales voice agent. When ON (and a sales phone number is configured), inbound calls to the dedicated platform line reach an AI sales rep that pitches the platform to prospective DME businesses, emails them information, captures leads for follow-up, and can start a tenant sign-up on the call. Seeded OFF — it answers regulated calls and costs real voice spend, so enable it once the sales number is wired up.', 'Voice & AI')
) AS v("key", "enabled", "description", "category")
ON CONFLICT ("org_id", "key") DO NOTHING;
