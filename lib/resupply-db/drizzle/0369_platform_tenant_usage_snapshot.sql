-- 0369_platform_tenant_usage_snapshot
-- Batch usage snapshot for /platform/billing/tenants so platform operators
-- can fetch all tenant usage in one DB round-trip (instead of per-tenant N+1).

CREATE OR REPLACE FUNCTION "resupply"."platform_tenant_usage_snapshot"(
  p_month_start timestamptz DEFAULT date_trunc('month', now())
)
RETURNS TABLE (
  org_id uuid,
  active_patients bigint,
  seats bigint,
  locations bigint,
  orders_per_month bigint,
  active_subscriptions bigint,
  outbound_messages_per_month bigint,
  ai_text_interactions_per_month bigint,
  billing_transactions_per_month bigint,
  fax_events bigint,
  ai_voice_events bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH month_key AS (
    SELECT date_trunc('month', p_month_start)::date AS month
  ),
  patient_counts AS (
    SELECT p.org_id, count(*)::bigint AS active_patients
    FROM resupply.patients p
    GROUP BY p.org_id
  ),
  seat_counts AS (
    SELECT au.org_id, count(*)::bigint AS seats
    FROM resupply.admin_users au
    WHERE au.status = 'active'
    GROUP BY au.org_id
  ),
  location_counts AS (
    SELECT l.org_id, count(*)::bigint AS locations
    FROM resupply.locations l
    WHERE COALESCE((to_jsonb(l) ->> 'status') = 'active', l.is_active)
    GROUP BY l.org_id
  ),
  order_counts AS (
    SELECT so.org_id, count(*)::bigint AS orders_per_month
    FROM resupply.shop_orders so
    CROSS JOIN month_key mk
    WHERE so.created_at >= mk.month::timestamptz
    GROUP BY so.org_id
  ),
  subscription_counts AS (
    SELECT ss.org_id, count(*)::bigint AS active_subscriptions
    FROM resupply.shop_subscriptions ss
    WHERE ss.status IN ('active', 'trialing')
    GROUP BY ss.org_id
  ),
  metered_rollups AS (
    SELECT
      r.org_id,
      sum(r.quantity) FILTER (WHERE r.metric_key = 'outboundMessagesPerMonth')::bigint AS outbound_messages_per_month,
      sum(r.quantity) FILTER (WHERE r.metric_key = 'aiTextInteractionsPerMonth')::bigint AS ai_text_interactions_per_month,
      sum(r.quantity) FILTER (WHERE r.metric_key = 'billingTransactionsPerMonth')::bigint AS billing_transactions_per_month,
      sum(r.quantity) FILTER (WHERE r.metric_key = 'faxEvents')::bigint AS fax_events,
      sum(r.quantity) FILTER (WHERE r.metric_key = 'aiVoiceEvents')::bigint AS ai_voice_events
    FROM resupply.tenant_usage_monthly_rollups r
    CROSS JOIN month_key mk
    WHERE r.month = mk.month
    GROUP BY r.org_id
  )
  SELECT
    o.id AS org_id,
    COALESCE(pc.active_patients, 0)::bigint AS active_patients,
    COALESCE(sc.seats, 0)::bigint AS seats,
    COALESCE(lc.locations, 0)::bigint AS locations,
    COALESCE(oc.orders_per_month, 0)::bigint AS orders_per_month,
    COALESCE(ssc.active_subscriptions, 0)::bigint AS active_subscriptions,
    COALESCE(mr.outbound_messages_per_month, 0)::bigint AS outbound_messages_per_month,
    COALESCE(mr.ai_text_interactions_per_month, 0)::bigint AS ai_text_interactions_per_month,
    COALESCE(mr.billing_transactions_per_month, 0)::bigint AS billing_transactions_per_month,
    COALESCE(mr.fax_events, 0)::bigint AS fax_events,
    COALESCE(mr.ai_voice_events, 0)::bigint AS ai_voice_events
  FROM resupply.organizations o
  LEFT JOIN patient_counts pc ON pc.org_id = o.id
  LEFT JOIN seat_counts sc ON sc.org_id = o.id
  LEFT JOIN location_counts lc ON lc.org_id = o.id
  LEFT JOIN order_counts oc ON oc.org_id = o.id
  LEFT JOIN subscription_counts ssc ON ssc.org_id = o.id
  LEFT JOIN metered_rollups mr ON mr.org_id = o.id;
$$;
