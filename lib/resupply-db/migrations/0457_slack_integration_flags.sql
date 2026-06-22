-- 0457_slack_integration_flags — Control Center toggles for the Slack
-- team-notification integration.
--
-- WHAT THESE GATE
-- ---------------
-- slack.notifications — when ENABLED for a tenant (and SLACK_BOT_TOKEN +
--   SLACK_ALERTS_CHANNEL are configured in System Configuration), real-time
--   CS alerts post into the operator's Slack channel: a patient reply that
--   needs a human (conversation → awaiting_admin), a voice post-call handoff,
--   and an SLA breach. Messages are NON-PHI (a reference + status + a deep
--   link into /admin) — never message bodies, phone numbers, or clinical
--   detail.
-- slack.interactivity — when ENABLED, the inbound endpoint
--   (/resupply-api/slack/interactivity + /commands) accepts Slack button
--   clicks and slash commands. Every inbound request is verified against the
--   SLACK_SIGNING_SECRET; the flag is a second on/off switch on top of that.
--
-- WHY ON BY DEFAULT (and still inert until configured)
-- ----------------------------------------------------
-- Both are a complete no-op until their Slack credentials are entered: with
-- no bot token nothing is ever posted, and with no signing secret the inbound
-- endpoint 503s. So they follow the table's default-on posture (new features
-- ship enabled) — an operator turns the integration ON by entering
-- credentials, not by flipping a flag, and can still disable either surface
-- from Control Center without removing the credentials.
--
-- feature_flags is PER-TENANT since migration 0350 (PK re-keyed from (key)
-- to (org_id, key)), so seed one row per organization and conflict on
-- (org_id, key). ON CONFLICT DO NOTHING keeps re-runs idempotent and never
-- clobbers an admin's intentional toggle.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.
-- Keep in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts.

INSERT INTO resupply.feature_flags ("org_id", "key", "enabled", "description", "category")
SELECT o."id", v."key", v."enabled", v."description", v."category"
FROM "resupply"."organizations" o
CROSS JOIN (VALUES
  ('slack.notifications',
   true,
   'Post real-time CS alerts (a patient reply needing a human, a voice post-call handoff, an SLA breach) into the operator''s Slack channel. Inert until a Slack bot token + alerts channel are configured in System Configuration. Messages are non-PHI (reference + status + a deep link into the admin console).',
   'Integrations'),
  ('slack.interactivity',
   true,
   'Accept inbound Slack button clicks (Escalate) and the /pennfit slash command. Every request is verified against the Slack signing secret; inert until that secret is configured in System Configuration.',
   'Integrations')
) AS v("key", "enabled", "description", "category")
ON CONFLICT ("org_id", "key") DO NOTHING;
