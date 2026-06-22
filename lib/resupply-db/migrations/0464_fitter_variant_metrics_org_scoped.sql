-- 0464_fitter_variant_metrics_org_scoped — scope the per-variant fitter
-- campaign metrics view per tenant.
--
-- `fitter_campaign_touch_variant_metrics` (a VIEW, migration 0157) aggregates
-- `fitter_campaign_touches` / `_clicks` by (touch_index, subject_variant_key)
-- with NO tenant dimension, so the admin "campaign metrics → variants"
-- expander sums every tenant's A/B sends, opens, and clicks together. Both
-- base tables carry org_id (migration 0341).
--
-- Migration 0382 fixed the SIBLING view `fitter_campaign_touch_metrics` (the
-- touch rollup) the same way but missed this variant view. This redefines it
-- to group by (org_id, touch_index, subject_variant_key) and expose org_id so
-- the admin read can filter to its own tenant (the route filter ships in the
-- same PR). Single-tenant (seed) behavior is unchanged.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent (DROP VIEW IF
-- EXISTS + CREATE VIEW; CREATE INDEX IF NOT EXISTS).

-- Adding org_id at the front changes the column list, which CREATE OR REPLACE
-- VIEW forbids; drop and recreate. Now one row per
-- (org_id, touch_index, subject_variant_key).
DROP VIEW IF EXISTS "resupply"."fitter_campaign_touch_variant_metrics";
--> statement-breakpoint
CREATE VIEW "resupply"."fitter_campaign_touch_variant_metrics" AS
SELECT
  em.org_id,
  em.touch_index,
  em.subject_variant_key,
  em.sends AS email_sends,
  em.failures AS email_failures,
  em.opens,
  COALESCE(cl.clicks, 0) AS clicks
FROM (
  SELECT
    org_id,
    touch_index,
    subject_variant_key,
    COUNT(*) FILTER (WHERE status = 'sent') AS sends,
    COUNT(*) FILTER (WHERE status = 'failed') AS failures,
    COALESCE(SUM(open_count), 0) AS opens
  FROM "resupply"."fitter_campaign_touches"
  WHERE channel = 'email'
  GROUP BY org_id, touch_index, subject_variant_key
) em
LEFT JOIN (
  SELECT
    org_id,
    touch_index,
    subject_variant_key,
    COUNT(*) AS clicks
  FROM "resupply"."fitter_campaign_clicks"
  GROUP BY org_id, touch_index, subject_variant_key
) cl
USING (org_id, touch_index, subject_variant_key);
--> statement-breakpoint

-- Reporting index: per-(org, variant) scans group on these columns.
CREATE INDEX IF NOT EXISTS "fitter_campaign_touches_org_variant_idx"
  ON "resupply"."fitter_campaign_touches" ("org_id", "touch_index", "subject_variant_key");
