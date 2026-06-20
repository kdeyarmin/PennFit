-- 0382_payer_stats_and_fitter_metrics_org_scoped — multi-tenant: scope the
-- two remaining grain-keyed analytics objects per tenant (slice 3, the last
-- of docs/multi-tenant-analytics-grain-redesign-plan.md).
--
-- (1) payer_estimate_stats (mig 0230) — the LEARNED per-payer out-of-pocket
--     estimate the public storefront shows patients. It is keyed by payer
--     `slug` alone and learned from adjudicated claims, so today every tenant
--     reads stats learned from the SEED tenant's claims. Payer allowables /
--     contracts differ by DME, so a second tenant must learn from — and read
--     — its OWN claims (a new tenant with too few claims falls back to the
--     static range, exactly as a low-sample slug does today). Re-key
--     (slug) -> (org_id, slug) and add p_org_id to the payer_oop_samples RPC.
--
-- (2) fitter_campaign_touch_metrics (mig 0155) — a VIEW aggregating
--     fitter_campaign_touches / _clicks by touch_index with NO tenant
--     dimension, so the admin "campaign metrics" page sums every tenant's
--     touches together. Both base tables carry org_id (0341); redefine the
--     view to group by (org_id, touch_index) and expose org_id so the admin
--     read can filter to its own tenant.
--
-- NOT INCLUDED — integration_run_health (also on 0342's deferred list) is
-- ALREADY per-tenant by convention: its callers key each row
-- `${JOB}:${orgId}` (office-ally-inbound-poll / therapy-integrations-nightly-
-- sync), so rows are tenant-distinct without an org_id column. No change.
--
-- The runtime cutover (refreshPayerEstimateStats fans out per tenant and
-- passes p_org_id; the storefront estimate reads its host tenant's stats; the
-- admin fitter-metrics read filters org_id) ships in the same PR.
-- Single-tenant (seed) behavior is unchanged.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

-- ── payer_estimate_stats: re-key per tenant ──
ALTER TABLE "resupply"."payer_estimate_stats"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."payer_estimate_stats"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "resupply"."payer_estimate_stats"
  ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "resupply"."payer_estimate_stats"
  DROP CONSTRAINT IF EXISTS "payer_estimate_stats_pkey";
--> statement-breakpoint
ALTER TABLE "resupply"."payer_estimate_stats"
  ADD CONSTRAINT "payer_estimate_stats_pkey" PRIMARY KEY ("org_id", "slug");
--> statement-breakpoint
-- payer_estimate_stats was created as a "plain table (no RLS)" in 0230.
-- Enable RLS + the org_isolation policy now that it carries org_id (mirrors
-- 0348; service_role bypasses, so this is a defense-in-depth backstop).
ALTER TABLE "resupply"."payer_estimate_stats" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "resupply"."payer_estimate_stats";
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "resupply"."payer_estimate_stats"
  USING ("org_id" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint

-- ── payer_oop_samples RPC — per tenant ──
-- The learned-stats refresh must scan only the calling tenant's adjudicated
-- claims. Drop the global single-arg signature and replace it with an
-- (org, cutoff) version filtering insurance_claims.org_id (added in 0335).
DROP FUNCTION IF EXISTS resupply.payer_oop_samples(timestamptz);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resupply.payer_oop_samples(
  p_org_id uuid,
  p_cutoff timestamptz
)
RETURNS TABLE(payer_name text, oop_cents bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  SELECT
    COALESCE(c.payer_name, 'unknown')::text AS payer_name,
    SUM(GREATEST(0, li.allowed_cents - li.paid_cents))::bigint AS oop_cents
  FROM resupply.insurance_claims c
  JOIN resupply.insurance_claim_line_items li ON li.claim_id = c.id
  WHERE c.status IN ('paid', 'closed')
    AND c.decision_at >= p_cutoff
    AND c.org_id = p_org_id
  GROUP BY c.id, c.payer_name
  HAVING SUM(li.allowed_cents) > 0
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resupply.payer_oop_samples(uuid, timestamptz)
  TO service_role;
--> statement-breakpoint

-- ── fitter_campaign_touch_metrics VIEW — per tenant ──
-- Adding the org_id column at the front changes the column list, which
-- CREATE OR REPLACE VIEW forbids; drop and recreate. Now one row per
-- (org_id, touch_index): the org universe is every tenant with a touch or a
-- click, and each channel aggregate groups by (org_id, touch_index).
DROP VIEW IF EXISTS "resupply"."fitter_campaign_touch_metrics";
--> statement-breakpoint
CREATE VIEW "resupply"."fitter_campaign_touch_metrics" AS
SELECT
  orgs.org_id,
  ti.touch_index,
  COALESCE(em.sends, 0) AS email_sends,
  COALESCE(em.failures, 0) AS email_failures,
  COALESCE(em.opens, 0) AS opens,
  COALESCE(sm.sends, 0) AS sms_sends,
  COALESCE(sm.failures, 0) AS sms_failures,
  COALESCE(cl.clicks, 0) AS clicks
FROM (
  SELECT "org_id" FROM "resupply"."fitter_campaign_touches"
  UNION
  SELECT "org_id" FROM "resupply"."fitter_campaign_clicks"
) orgs
CROSS JOIN generate_series(1, 11) ti(touch_index)
LEFT JOIN (
  SELECT
    org_id,
    touch_index,
    COUNT(*) FILTER (WHERE status = 'sent') AS sends,
    COUNT(*) FILTER (WHERE status = 'failed') AS failures,
    COALESCE(SUM(open_count), 0) AS opens
  FROM "resupply"."fitter_campaign_touches"
  WHERE channel = 'email'
  GROUP BY org_id, touch_index
) em USING (org_id, touch_index)
LEFT JOIN (
  SELECT
    org_id,
    touch_index,
    COUNT(*) FILTER (WHERE status = 'sent') AS sends,
    COUNT(*) FILTER (WHERE status = 'failed') AS failures
  FROM "resupply"."fitter_campaign_touches"
  WHERE channel = 'sms'
  GROUP BY org_id, touch_index
) sm USING (org_id, touch_index)
LEFT JOIN (
  SELECT org_id, touch_index, COUNT(*) AS clicks
  FROM "resupply"."fitter_campaign_clicks"
  GROUP BY org_id, touch_index
) cl USING (org_id, touch_index);
