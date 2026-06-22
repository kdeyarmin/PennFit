-- 0437 — server-side window aggregates for the resupply-program KPIs.
--
-- Background: GET /admin/analytics/resupply-kpis pulled FOUR capped reads
-- into Node and reduced them in JS:
--   * episode-linked conversations in the window — `.limit(20000)`
--   * inbound messages in the window — `.limit(50000)`
--   * fulfillment line items in the window — `.limit(50000)`
--   * paid storefront orders in the window — `.limit(50000)`
-- Past those caps the connection rate / items-per-order / average order
-- value were computed over an arbitrary truncated slice. This function
-- moves ONLY those four count/sum aggregations into Postgres and returns a
-- single row of integers. The episode rollup (status funnel + unique
-- patients) is NOT capped — it is window-bounded only — so it stays a
-- table read in the route. The KPI ratio math stays in the pure, tested
-- aggregateResupplyKpis() helper, which now consumes the pre-aggregated
-- integers; the response is byte-for-byte the same, minus the truncation.
--
-- Output contract mirrors the JS exactly:
--   * outreach_count — episode-linked conversations created since the
--     cutoff. (conversations.episode_id is NOT NULL, but the JS kept the
--     `episode_id IS NOT NULL` predicate, so we mirror it.)
--   * responded_count — DISTINCT conversation_id among inbound messages
--     created since the cutoff whose conversation is one of those outreach
--     conversations (episode-linked, in-window). Same intersection the JS
--     built with the outreachIds Set.
--   * fulfillment_line_items — fulfillment rows created since the cutoff.
--   * orders_with_fulfillments — DISTINCT episode_id among those rows
--     (episode_id is NOT NULL, mirroring the JS `filter(r.episode_id)`).
--   * paid_order_count / paid_order_sum_cents — paid storefront orders
--     created since the cutoff WITH a non-null amount_total_cents (the JS
--     dropped non-numeric amounts from both the count and the mean). Sum
--     is bigint to avoid overflow on a large window.
--
-- Org-scoped: every source table carries org_id (migrations 0333 / 0334);
-- the function filters each read by p_org_id. STABLE SECURITY DEFINER with
-- a pinned search_path; EXECUTE granted to service_role only.

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

CREATE OR REPLACE FUNCTION resupply.resupply_kpi_window_aggregates(
  p_org_id uuid,
  p_cutoff timestamptz
)
RETURNS TABLE(
  outreach_count bigint,
  responded_count bigint,
  fulfillment_line_items bigint,
  orders_with_fulfillments bigint,
  paid_order_count bigint,
  paid_order_sum_cents bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  WITH outreach AS (
    SELECT c.id
    FROM resupply.conversations c
    WHERE c.org_id = p_org_id
      AND c.episode_id IS NOT NULL
      AND c.created_at >= p_cutoff
  ),
  responded AS (
    SELECT COUNT(DISTINCT m.conversation_id)::bigint AS n
    FROM resupply.messages m
    JOIN outreach o ON o.id = m.conversation_id
    WHERE m.org_id = p_org_id
      AND m.direction = 'inbound'
      AND m.created_at >= p_cutoff
  ),
  fulfillment AS (
    SELECT
      COUNT(*)::bigint AS line_items,
      COUNT(DISTINCT f.episode_id) FILTER (
        WHERE f.episode_id IS NOT NULL
      )::bigint AS orders_with
    FROM resupply.fulfillments f
    WHERE f.org_id = p_org_id
      AND f.created_at >= p_cutoff
  ),
  paid_orders AS (
    SELECT
      COUNT(*)::bigint AS n,
      COALESCE(SUM(o.amount_total_cents), 0)::bigint AS sum_cents
    FROM resupply.shop_orders o
    WHERE o.org_id = p_org_id
      AND o.status = 'paid'
      AND o.created_at >= p_cutoff
      AND o.amount_total_cents IS NOT NULL
  )
  SELECT
    (SELECT COUNT(*)::bigint FROM outreach) AS outreach_count,
    (SELECT n FROM responded) AS responded_count,
    (SELECT line_items FROM fulfillment) AS fulfillment_line_items,
    (SELECT orders_with FROM fulfillment) AS orders_with_fulfillments,
    (SELECT n FROM paid_orders) AS paid_order_count,
    (SELECT sum_cents FROM paid_orders) AS paid_order_sum_cents
$$;
--> statement-breakpoint

-- SECURITY DEFINER: drop the implicit PUBLIC execute (which is what exposes
-- anon/authenticated over PostgREST) and keep only the service-role grant.
REVOKE EXECUTE ON FUNCTION resupply.resupply_kpi_window_aggregates(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION resupply.resupply_kpi_window_aggregates(uuid, timestamptz)
  TO service_role;
