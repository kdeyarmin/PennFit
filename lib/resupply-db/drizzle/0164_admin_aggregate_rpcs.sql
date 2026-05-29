-- 0164 — server-side aggregation RPCs for two admin read endpoints
--> statement-breakpoint
-- that were scanning up to 10,000 rows into Node and grouping in JS
-- on every request.
--
-- Background: PostgREST has no GROUP BY / FILTER-aggregate surface, so
-- both `/admin/billing/denial-rate` and `/admin/shop/back-in-stock-queue`
-- fetched the raw rows (capped at 10k) and reduced them in the route
-- handler. That's O(table) memory + transfer on every page load and
-- degrades as claim / notification volume grows. These two SQL
-- functions push the aggregation into Postgres (which has the right
-- indexes) so the route receives only the small grouped result set.
--
-- Both follow the established RPC pattern in this tree (see
-- 0143_inventory_reconciliation_submit_fn): SECURITY DEFINER + pinned
-- search_path + GRANT EXECUTE to service_role only. They are STABLE
-- (read-only, no side effects) so the planner can optimize freely.

-- ── billing denial-rate ────────────────────────────────────────────
-- Per-payer decision + denial counts over claims whose decision_at is
-- within the caller-supplied window and whose status is one of the
-- terminal/decisioned set. Mirrors the JS logic the route previously
-- ran: a row counts as a "denial" when status IN ('denied','appealed').
-- The route sums these rows for the overall headline number, so the
-- function returns per-payer granularity only.
CREATE OR REPLACE FUNCTION resupply.billing_denial_rate(p_cutoff timestamptz)
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
  WHERE decision_at >= p_cutoff
    AND status IN ('denied', 'paid', 'closed', 'appealed')
  GROUP BY COALESCE(payer_name, 'unknown')
$$;

GRANT EXECUTE ON FUNCTION resupply.billing_denial_rate(timestamptz) TO service_role;

-- ── back-in-stock queue ────────────────────────────────────────────
-- Per-product rollup of the notification queue: pending vs notified vs
-- delivered counts, plus the oldest still-pending signup and the most
-- recent notification. Ordered to match the route's previous JS sort
-- (most pending first, then oldest-pending first) and capped at the
-- same 200 distinct products the route surfaced. NULLS LAST keeps a
-- product with zero pending (oldest_pending_at IS NULL) from sorting
-- ahead of one with a real oldest-pending timestamp.
CREATE OR REPLACE FUNCTION resupply.shop_back_in_stock_queue()
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
  GROUP BY product_id
  ORDER BY pending_count DESC, oldest_pending_at ASC NULLS LAST
  LIMIT 200
$$;

GRANT EXECUTE ON FUNCTION resupply.shop_back_in_stock_queue() TO service_role;
