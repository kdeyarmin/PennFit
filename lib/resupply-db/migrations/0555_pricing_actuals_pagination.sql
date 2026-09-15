-- Read all-event totals and a bounded history page under the same tenant lock.
-- Financial events are append-only, so ascending creation order keeps earlier
-- pages stable when new events arrive. No financial result is a page subtotal.
CREATE OR REPLACE FUNCTION resupply.pricing_actuals_page(
  p_org_id uuid,p_quote_id uuid,p_offset integer DEFAULT 0,p_limit integer DEFAULT 100
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE q resupply.pricing_quotes%rowtype; events jsonb; total bigint;
  revenue numeric; cost numeric; page_offset integer; page_limit integer;
BEGIN
  PERFORM resupply.pricing_lock_state(p_org_id);
  SELECT * INTO q FROM resupply.pricing_quotes WHERE org_id=p_org_id AND id=p_quote_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
  IF p_offset IS NULL OR p_offset<0 OR p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN
    RAISE EXCEPTION 'invalid_body' USING ERRCODE='22023';
  END IF;
  page_offset := p_offset; page_limit := p_limit;
  SELECT count(*),
    coalesce(sum(CASE kind WHEN 'revenue' THEN amount_cents WHEN 'refund' THEN -amount_cents ELSE 0 END),0),
    coalesce(sum(CASE kind WHEN 'cost' THEN amount_cents WHEN 'cost_credit' THEN -amount_cents ELSE 0 END),0)
    INTO total,revenue,cost FROM resupply.pricing_actual_events WHERE org_id=p_org_id AND quote_id=p_quote_id;
  SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.created_at,e.id),'[]'::jsonb) INTO events
    FROM (SELECT * FROM resupply.pricing_actual_events WHERE org_id=p_org_id AND quote_id=p_quote_id
      ORDER BY created_at,id OFFSET page_offset LIMIT page_limit) e;
  RETURN jsonb_build_object('quote',to_jsonb(q),'events',events,'actualRevenueCents',revenue,'actualCostCents',cost,
    'eventPage',jsonb_build_object('offset',page_offset,'limit',page_limit,'total',total,'hasMore',page_offset::bigint+page_limit<total));
END;
$$;
REVOKE ALL ON FUNCTION resupply.pricing_actuals_page(uuid,uuid,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION resupply.pricing_actuals_page(uuid,uuid,integer,integer) TO service_role;
