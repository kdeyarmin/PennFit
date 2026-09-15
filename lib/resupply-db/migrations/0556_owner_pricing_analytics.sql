-- Read-only owner analytics. Financial periods use the recorded economic date;
-- creation timestamps never stand in for absent or malformed evidence dates.
CREATE OR REPLACE FUNCTION resupply.owner_pricing_event_time(p_value text)
RETURNS timestamptz LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
BEGIN
  IF p_value IS NULL OR length(p_value)>100 OR p_value !~
    '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
  THEN RETURN NULL; END IF;
  RETURN p_value::timestamptz;
EXCEPTION WHEN SQLSTATE '22007' OR SQLSTATE '22008' OR SQLSTATE '22009' THEN
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resupply.owner_pricing_analytics(
  p_org_id uuid,p_from timestamptz,p_to timestamptz,p_as_of timestamptz
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' SET timezone='UTC' AS $$
DECLARE result jsonb;
BEGIN
  IF p_org_id IS NULL OR p_from IS NULL OR p_to IS NULL OR p_as_of IS NULL
    OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR NOT isfinite(p_as_of)
    OR p_from>=p_to OR p_to>p_as_of
    OR extract(epoch FROM p_to-p_from)>366*86400
  THEN RAISE EXCEPTION 'invalid_analytics_window' USING ERRCODE='22023'; END IF;

  -- UTC also keeps previous-interval subtraction independent of session DST.
  -- All sections share this statement's MVCC snapshot. The pricing state is
  -- read directly: fetching this dashboard must not activate scheduled prices.
  WITH events AS MATERIALIZED (
    SELECT e.quote_id,e.kind,e.source,e.amount_cents,
      resupply.owner_pricing_event_time(e.data->>'occurredAt') occurred_at
    FROM resupply.pricing_actual_events e WHERE e.org_id=p_org_id
  ), by_quote AS (
    SELECT e.quote_id,
      coalesce(sum(CASE e.kind WHEN 'revenue' THEN e.amount_cents WHEN 'refund' THEN -e.amount_cents ELSE 0 END)
        FILTER(WHERE e.occurred_at<=p_as_of),0) revenue,
      coalesce(sum(CASE e.kind WHEN 'cost' THEN e.amount_cents WHEN 'cost_credit' THEN -e.amount_cents ELSE 0 END)
        FILTER(WHERE e.occurred_at<=p_as_of),0) cost,
      bool_or(e.occurred_at IS NULL OR e.occurred_at>p_as_of) uncertain
    FROM events e GROUP BY e.quote_id
  ), bound AS (
    SELECT q.id,q.costs_complete,q.revenue_complete,
      coalesce(a.uncertain,false) uncertain,
      q.costs_complete AND q.revenue_complete AND NOT coalesce(a.uncertain,false) settled,
      coalesce(a.revenue,0) revenue,coalesce(a.cost,0) cost
    FROM resupply.pricing_quotes q LEFT JOIN by_quote a ON a.quote_id=q.id
    WHERE q.org_id=p_org_id AND q.status='bound'
  ), periods AS (
    SELECT 'current' label,p_from starts,p_to ends
    UNION ALL SELECT 'previous',p_from-(p_to-p_from),p_from
  ), period_totals AS (
    SELECT p.label,jsonb_build_object(
      'revenueCents',coalesce(sum(CASE e.kind WHEN 'revenue' THEN e.amount_cents WHEN 'refund' THEN -e.amount_cents ELSE 0 END),0),
      'costCents',coalesce(sum(CASE e.kind WHEN 'cost' THEN e.amount_cents WHEN 'cost_credit' THEN -e.amount_cents ELSE 0 END),0),
      'eventCount',count(e.quote_id),
      'revenueEventCount',count(*) FILTER(WHERE e.kind IN ('revenue','refund')),
      'costEventCount',count(*) FILTER(WHERE e.kind IN ('cost','cost_credit')),
      'quoteCount',count(DISTINCT e.quote_id)) value
    FROM periods p LEFT JOIN events e ON e.occurred_at>=p.starts AND e.occurred_at<p.ends
    GROUP BY p.label
  ), current_events AS (
    SELECT * FROM events WHERE occurred_at>=p_from AND occurred_at<p_to
  ), daily AS (
    SELECT to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS metric_date,
      sum(CASE e.kind WHEN 'revenue' THEN e.amount_cents WHEN 'refund' THEN -e.amount_cents ELSE 0 END) revenue,
      sum(CASE e.kind WHEN 'cost' THEN e.amount_cents WHEN 'cost_credit' THEN -e.amount_cents ELSE 0 END) cost,
      count(*) n
    FROM current_events e GROUP BY 1
  ), sources AS (
    SELECT e.source,sum(CASE e.kind WHEN 'cost' THEN e.amount_cents ELSE -e.amount_cents END) cost,count(*) n
    FROM current_events e WHERE e.kind IN ('cost','cost_credit') GROUP BY e.source
  ) SELECT jsonb_build_object(
    'current',(SELECT value FROM period_totals WHERE label='current'),
    'previous',(SELECT value FROM period_totals WHERE label='previous'),
    'settled',(SELECT jsonb_build_object(
      'boundOrders',count(*),
      'settledOrders',count(*) FILTER(WHERE b.settled),
      'incompleteOrders',count(*) FILTER(WHERE NOT b.settled),
      'costsIncompleteOrders',count(*) FILTER(WHERE NOT b.costs_complete),
      'revenueIncompleteOrders',count(*) FILTER(WHERE NOT b.revenue_complete),
      'uncertainOrders',count(*) FILTER(WHERE b.uncertain),
      'netRevenueCents',coalesce(sum(b.revenue) FILTER(WHERE b.settled),0),
      'netCostCents',coalesce(sum(b.cost) FILTER(WHERE b.settled),0),
      'contributionCents',coalesce(sum(b.revenue-b.cost) FILTER(WHERE b.settled),0)
    ) FROM bound b),
    'quality',(SELECT jsonb_build_object(
      'undatedEvents',count(*) FILTER(WHERE e.occurred_at IS NULL),
      'futureDatedEvents',count(*) FILTER(WHERE e.occurred_at>p_as_of)
    ) FROM events e),
    'pricing',jsonb_build_object(
      'pendingApprovals',(SELECT count(*) FROM resupply.pricing_quotes q WHERE q.org_id=p_org_id AND q.status='pending_approval'),
      'openProposals',(SELECT count(*) FROM resupply.pricing_proposals p WHERE p.org_id=p_org_id AND p.status IN ('open','reviewing')),
      'enabled',coalesce((SELECT s.enabled FROM resupply.pricing_state s WHERE s.org_id=p_org_id),false),
      'enforceQuotes',coalesce((SELECT s.enforce_quotes FROM resupply.pricing_state s WHERE s.org_id=p_org_id),false),
      'policyConfigured',coalesce((SELECT s.current_policy_id IS NOT NULL FROM resupply.pricing_state s WHERE s.org_id=p_org_id),false),
      'activePriceListConfigured',coalesce((SELECT s.active_price_list_id IS NOT NULL FROM resupply.pricing_state s WHERE s.org_id=p_org_id),false)
    ),
    'daily',(SELECT coalesce(jsonb_agg(jsonb_build_object('date',d.metric_date,'revenueCents',d.revenue,'costCents',d.cost,'eventCount',d.n) ORDER BY d.metric_date),'[]'::jsonb) FROM daily d),
    'costSources',(SELECT coalesce(jsonb_agg(jsonb_build_object('source',s.source,'costCents',s.cost,'eventCount',s.n) ORDER BY s.source),'[]'::jsonb) FROM sources s)
  ) INTO result;
  RETURN result;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resupply.owner_pricing_event_time(text),resupply.owner_pricing_analytics(uuid,timestamptz,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION resupply.owner_pricing_event_time(text),resupply.owner_pricing_analytics(uuid,timestamptz,timestamptz,timestamptz) TO service_role;
