-- 0436 — server-side per-customer LTV/CAC economics RPC.
--
-- Background: GET /admin/analytics/ltv-cac previously pulled up to
-- `.limit(20000)` paid `shop_orders` rows AND up to `.limit(20000)`
-- `customer_acquisition` rows into the Node process and reduced them to a
-- per-customer (lifetime revenue, channel, acquisition cost) tuple in JS
-- before handing the flattened rows to the pure `buildLtvCacReport`. Past
-- the cap that aggregation silently truncated — a practice with >20k paid
-- orders (or >20k attributed customers) would compute LTV:CAC over an
-- arbitrary slice. This function moves ONLY the per-customer rollup into
-- Postgres; the channel rollup / ratio math stays in the tested
-- `buildLtvCacReport` (called on identical inputs), so the response is
-- byte-for-byte the same — it just can no longer truncate.
--
-- Output contract mirrors the JS exactly:
--   * Revenue numerator: paid orders only — `paid_at IS NOT NULL` AND
--     `status <> 'refunded'` (refunded orders keep paid_at set, so they
--     must be excluded explicitly; the same rule as the Customer-360
--     rollup). Sum of `amount_total_cents` (NULL → 0). Orders with a
--     NULL/empty `customer_id` are skipped (cannot be attributed).
--   * Attribution: one `customer_acquisition` row per customer →
--     `channel` + `acquisition_cost_cents` (which may be NULL = unknown
--     cost; an unknown-cost customer is never counted as $0 downstream).
--   * Result rows: the UNION of every customer who has paid revenue OR an
--     attribution row. `lifetime_revenue_cents` defaults to 0 for an
--     attribution-only customer; `channel` is NULL for a revenue-only
--     customer (→ "unattributed" in the report).
--
-- Org-scoped: both source tables carry `org_id` (migrations 0334 / 0341);
-- the function filters every read by `p_org_id`. STABLE SECURITY DEFINER
-- with a pinned search_path, EXECUTE granted to service_role only.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION resupply.ltv_cac_customer_economics(
  p_org_id uuid
)
RETURNS TABLE(
  customer_id text,
  lifetime_revenue_cents bigint,
  channel text,
  acquisition_cost_cents integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  WITH revenue AS (
    SELECT
      o.customer_id AS customer_id,
      COALESCE(SUM(o.amount_total_cents), 0)::bigint AS lifetime_revenue_cents
    FROM resupply.shop_orders o
    WHERE o.org_id = p_org_id
      AND o.paid_at IS NOT NULL
      AND o.status <> 'refunded'
      AND o.customer_id IS NOT NULL
      AND o.customer_id <> ''
    GROUP BY o.customer_id
  ),
  attribution AS (
    SELECT
      a.customer_id AS customer_id,
      a.channel AS channel,
      a.acquisition_cost_cents AS acquisition_cost_cents
    FROM resupply.customer_acquisition a
    WHERE a.org_id = p_org_id
      AND a.customer_id IS NOT NULL
      AND a.customer_id <> ''
  )
  SELECT
    COALESCE(r.customer_id, a.customer_id) AS customer_id,
    COALESCE(r.lifetime_revenue_cents, 0)::bigint AS lifetime_revenue_cents,
    a.channel,
    a.acquisition_cost_cents
  FROM revenue r
  FULL OUTER JOIN attribution a ON a.customer_id = r.customer_id
$$;
--> statement-breakpoint

-- SECURITY DEFINER: drop the implicit PUBLIC execute (which is what exposes
-- anon/authenticated over PostgREST) and keep only the service-role grant.
REVOKE EXECUTE ON FUNCTION resupply.ltv_cac_customer_economics(uuid)
  FROM PUBLIC, anon, authenticated;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION resupply.ltv_cac_customer_economics(uuid)
  TO service_role;
