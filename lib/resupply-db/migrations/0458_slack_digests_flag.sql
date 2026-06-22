-- 0458_slack_digests_flag — Control Center toggle for routing the operator
-- email DIGESTS into Slack (Slack integration, phase 2).
--
-- WHAT THIS GATES
-- ---------------
-- slack.digests — when ENABLED for a tenant (and a Slack bot token + channel
--   are configured), the recurring operator digests also post into Slack: the
--   owner weekly KPI digest, the daily metric-alerts digest, the stuck-job
--   (DLQ) monitor, and the low-stock inventory alert. They route to
--   SLACK_DIGESTS_CHANNEL when set (e.g. an #ops channel), else the default
--   alerts channel. Messages are NON-PHI (counts / KPI headlines / SKU + queue
--   names). The existing email path is unchanged — Slack is additive.
--
-- WHY ON BY DEFAULT (and inert until configured)
-- ----------------------------------------------
-- Like slack.notifications / slack.interactivity (migration 0457), this is a
-- complete no-op until Slack credentials are entered, so it follows the
-- table's default-on posture. An operator turns the integration on by entering
-- credentials, not by flipping a flag, and can still silence digests
-- independently of the real-time CS alerts from Control Center.
--
-- feature_flags is PER-TENANT since migration 0350 (PK (org_id, key)), so seed
-- one row per organization and conflict on (org_id, key). ON CONFLICT DO
-- NOTHING keeps re-runs idempotent and never clobbers an admin's toggle.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.
-- Keep in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts.

INSERT INTO resupply.feature_flags ("org_id", "key", "enabled", "description", "category")
SELECT o."id", v."key", v."enabled", v."description", v."category"
FROM "resupply"."organizations" o
CROSS JOIN (VALUES
  ('slack.digests',
   true,
   'Also post the operator digests (owner weekly KPIs, metric alerts, stuck-job DLQ monitor, low-stock inventory) into Slack. Routes to the optional digests channel, else the alerts channel. Inert until Slack credentials are configured. Non-PHI (counts / KPI headlines / SKU + queue names). The email path is unchanged.',
   'Integrations')
) AS v("key", "enabled", "description", "category")
ON CONFLICT ("org_id", "key") DO NOTHING;
