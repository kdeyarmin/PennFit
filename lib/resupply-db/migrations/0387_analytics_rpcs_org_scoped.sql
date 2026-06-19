-- 0387_analytics_rpcs_org_scoped — multi-tenant: scope the four remaining
-- admin analytics RPCs per tenant.
--
-- The getOrgScopedClient facade auto-appends `.eq("org_id", …)` to every
-- PostgREST `.from()` read/write, but it CANNOT reach inside a
-- SECURITY DEFINER function body — so any RPC must filter org_id itself.
-- These four were written before the org_id rollout and never got a
-- p_org_id parameter, so they aggregate across ALL tenants while being
-- called from tenant-admin routes (requireAdmin / requirePermission):
--
--   * billing_denial_rate        (0164)  -> admin/billing-reports.ts
--   * shop_back_in_stock_queue   (0164)  -> admin/shop-back-in-stock.ts
--   * location_rollup            (0253)  -> admin/locations.ts
--   * fulfillments_to_bill_count (0323)  -> admin/billing-director.ts
--
-- Every underlying table already carries org_id (insurance_claims 0335,
-- shop_back_in_stock_notifications 0342, patients/admin_users 0330/0332,
-- fulfillments 0332). Re-key each function to take a leading p_org_id uuid
-- and filter on it — exactly the pattern 0382 used for payer_oop_samples.
-- The single-arg signatures are DROPped so a caller can't accidentally use
-- the unscoped version. The runtime cutover (each callsite passes
-- { p_org_id: req.orgId, … }) ships in the same change.
--
-- Single-tenant (seed) behavior is unchanged: every row already carries
-- the seed org_id, so the filtered count equals today's unfiltered count.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

-- service_role guard — vanilla Postgres (CI replay / from-scratch) has no
-- such role; create it idempotently (mirrors 0164/0253/0323).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- ── billing_denial_rate: per tenant ──
DROP FUNCTION IF EXISTS resupply.billing_denial_rate(timestamptz);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resupply.billing_denial_rate(
  p_org_id uuid,
  p_cutoff timestamptz
)
RETURNS TABLE(payer_name text, decisions bigint, denials bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  SELECT
    COALESCE(payer_name, 'unknown')::text AS payer_name,
    COUNT(*)::bigint AS decisions,
    COUNT(*) FILTER (WHERE status IN ('denied', 'appealed'))::bigint AS denials
  FROM resupply.insurance_claims
  WHERE org_id = p_org_id
    AND decision_at >= p_cutoff
    AND status IN ('denied', 'paid', 'closed', 'appealed')
  GROUP BY COALESCE(payer_name, 'unknown')
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resupply.billing_denial_rate(uuid, timestamptz)
  TO service_role;
--> statement-breakpoint

-- ── shop_back_in_stock_queue: per tenant ──
DROP FUNCTION IF EXISTS resupply.shop_back_in_stock_queue();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resupply.shop_back_in_stock_queue(p_org_id uuid)
RETURNS TABLE(
  product_id text,
  pending_count bigint,
  notified_count bigint,
  delivered_count bigint,
  oldest_pending_at timestamptz,
  last_notified_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  SELECT
    product_id,
    COUNT(*) FILTER (WHERE notified_at IS NULL)::bigint AS pending_count,
    COUNT(*) FILTER (WHERE notified_at IS NOT NULL)::bigint AS notified_count,
    COUNT(*) FILTER (WHERE delivered)::bigint AS delivered_count,
    MIN(created_at) FILTER (WHERE notified_at IS NULL) AS oldest_pending_at,
    MAX(notified_at) AS last_notified_at
  FROM resupply.shop_back_in_stock_notifications
  WHERE org_id = p_org_id
  GROUP BY product_id
  ORDER BY pending_count DESC, oldest_pending_at ASC NULLS LAST
  LIMIT 200
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resupply.shop_back_in_stock_queue(uuid)
  TO service_role;
--> statement-breakpoint

-- ── location_rollup: per tenant ──
DROP FUNCTION IF EXISTS resupply.location_rollup();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resupply.location_rollup(p_org_id uuid)
RETURNS TABLE(
  location_id uuid,
  patient_count bigint,
  active_patient_count bigint,
  staff_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  WITH p AS (
    SELECT
      location_id,
      COUNT(*) AS patient_count,
      COUNT(*) FILTER (WHERE status = 'active') AS active_patient_count
    FROM resupply.patients
    WHERE org_id = p_org_id
    GROUP BY location_id
  ),
  s AS (
    SELECT location_id, COUNT(*) AS staff_count
    FROM resupply.admin_users
    WHERE status <> 'revoked'
      AND org_id = p_org_id
    GROUP BY location_id
  ),
  keys AS (
    SELECT location_id FROM p
    UNION
    SELECT location_id FROM s
  )
  SELECT
    k.location_id,
    COALESCE(p.patient_count, 0)::bigint AS patient_count,
    COALESCE(p.active_patient_count, 0)::bigint AS active_patient_count,
    COALESCE(s.staff_count, 0)::bigint AS staff_count
  FROM keys k
  LEFT JOIN p ON p.location_id IS NOT DISTINCT FROM k.location_id
  LEFT JOIN s ON s.location_id IS NOT DISTINCT FROM k.location_id
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resupply.location_rollup(uuid) TO service_role;
--> statement-breakpoint

-- ── fulfillments_to_bill_count: per tenant ──
DROP FUNCTION IF EXISTS resupply.fulfillments_to_bill_count(timestamptz);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resupply.fulfillments_to_bill_count(
  p_org_id uuid,
  p_since timestamptz
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  SELECT COUNT(*)
  FROM resupply.fulfillments f
  WHERE f.org_id = p_org_id
    AND f.shipped_at >= p_since
    AND NOT EXISTS (
      SELECT 1
      FROM resupply.insurance_claims c
      WHERE c.fulfillment_id = f.id
    )
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resupply.fulfillments_to_bill_count(uuid, timestamptz)
  TO service_role;
