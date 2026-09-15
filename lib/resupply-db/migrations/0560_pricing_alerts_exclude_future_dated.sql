-- pricing_alerts: stop counting FUTURE-DATED evidence as already-happened.
--
-- 0554 introduced this function under the header comment
--   "Future versions must not conceal an expiration gap or trigger cost alerts
--    early."
-- but its `actuals` CTE aggregates every `pricing_actual_events` row for the
-- org with no bound on the economic date at all. The economic date lives in
-- `data->>'occurredAt'` (there is no column for it), so a row recorded today
-- carrying next month's date was summed as though it had already settled. Both
-- halves of that comment were violated:
--
--   * `actual_cost_overrun` fires when actual cost exceeds the quoted variable
--     cost. Counting a future-dated cost triggers the alert BEFORE the money is
--     spent — a false positive on a feed staff are meant to work.
--   * `collection_shortfall` fires when collected revenue is UNDER the quoted
--     net revenue. Counting future-dated revenue inflates the collected side
--     and CONCEALS a real shortfall.
--
-- The fix bounds `actuals` to evidence whose date is not in the future, reusing
-- `resupply.owner_pricing_event_time` (0556) to parse `occurredAt` — it returns
-- NULL for an absent or malformed value rather than raising.
--
-- Undated evidence (`occurred_at IS NULL`) stays counted, deliberately. It has
-- no date to compare, and dropping it would under-count real cost overruns.
-- 0556's `owner_pricing_analytics` already reports the population of such rows
-- as a data-quality signal (`quality.undatedEvents` / `futureDatedEvents`), so
-- an operator can see when these totals rest on undated evidence.
--
-- `collection_shortfall` additionally moves from an INNER to a LEFT join on
-- `actuals`. Date-bounding alone would have swapped one concealment for
-- another: a quote whose only revenue evidence is future-dated now produces no
-- `actuals` row at all, so an inner join drops it from the feed instead of
-- reporting the full shortfall. The same hole predates this migration — a quote
-- flagged `revenue_complete` with NO actual events ever recorded was silently
-- omitted, which is the largest shortfall there is. Joining left and reading
-- `coalesce(a.revenue,0)` reports it. `actual_cost_overrun` stays an INNER join
-- on purpose: with no recorded cost there is no overrun to claim.
--
-- Everything else is carried over verbatim from 0554.

CREATE OR REPLACE FUNCTION resupply.pricing_alerts(p_org_id uuid,p_offset integer DEFAULT 0,p_limit integer DEFAULT 101) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER STABLE SET search_path='' AS $$
WITH effective_offers AS (
 SELECT DISTINCT ON(id) * FROM resupply.pricing_offers WHERE org_id=p_org_id AND effective_from<=statement_timestamp() ORDER BY id,version DESC
), actuals AS (
 SELECT quote_id,sum(CASE kind WHEN 'cost' THEN amount_cents WHEN 'cost_credit' THEN -amount_cents ELSE 0 END) cost,sum(CASE kind WHEN 'revenue' THEN amount_cents WHEN 'refund' THEN -amount_cents ELSE 0 END) revenue
 FROM resupply.pricing_actual_events WHERE org_id=p_org_id
   AND coalesce(resupply.owner_pricing_event_time(data->>'occurredAt')<=statement_timestamp(),true)
 GROUP BY quote_id
), signals AS (
 SELECT 'offer_expired' code,o.id entity_id,NULL::bigint amount,o.created_at,o.version::text discriminator FROM effective_offers o WHERE o.expires_at<=statement_timestamp()
 UNION ALL SELECT 'supplier_cost_increase',o.id,((o.data->>'unitCostCents')::bigint-(prior.data->>'unitCostCents')::bigint),o.created_at,o.version::text FROM effective_offers o JOIN LATERAL (
   SELECT * FROM resupply.pricing_offers candidate WHERE candidate.org_id=p_org_id AND candidate.id=o.id AND candidate.version<o.version AND candidate.effective_from<=statement_timestamp() ORDER BY candidate.version DESC LIMIT 1
 ) prior ON true WHERE (o.data->>'unitCostCents')::bigint>(prior.data->>'unitCostCents')::bigint
 UNION ALL SELECT 'quote_'||q.approval_class,q.id,NULL::bigint,q.updated_at,q.revision::text FROM resupply.pricing_quotes q WHERE q.org_id=p_org_id AND q.status='pending_approval'
 UNION ALL SELECT 'actual_cost_overrun',q.id,a.cost-(q.evaluation->>'totalVariableCostCents')::bigint,q.updated_at,q.actuals_revision::text FROM resupply.pricing_quotes q JOIN actuals a ON a.quote_id=q.id WHERE q.org_id=p_org_id AND a.cost>(q.evaluation->>'totalVariableCostCents')::bigint
 UNION ALL SELECT 'collection_shortfall',q.id,(q.evaluation->>'netRevenueCents')::bigint-coalesce(a.revenue,0),q.updated_at,q.actuals_revision::text FROM resupply.pricing_quotes q LEFT JOIN actuals a ON a.quote_id=q.id WHERE q.org_id=p_org_id AND q.revenue_complete AND coalesce(a.revenue,0)<(q.evaluation->>'netRevenueCents')::bigint
 UNION ALL SELECT 'scheduled_activation_blocked',b.id,NULL::bigint,b.created_at,coalesce(b.scheduled_at::text,'') FROM resupply.pricing_price_lists b WHERE b.org_id=p_org_id AND b.schedule_status='blocked'
), keyed AS (SELECT *,md5(code||':'||entity_id::text||':'||discriminator) key FROM signals), paged AS (
 SELECT jsonb_build_object('key',k.key,'code',k.code,'entityId',k.entity_id,'amountCents',k.amount,'createdAt',k.created_at,'revision',coalesce(r.revision,0),'status',coalesce(r.status,'open'),'owner',coalesce(r.owner,''),'reviewAt',r.review_at,'notes',coalesce(r.notes,'')) item
 FROM keyed k LEFT JOIN resupply.pricing_alert_reviews r ON r.org_id=p_org_id AND r.key=k.key ORDER BY k.created_at DESC,k.key OFFSET greatest(p_offset,0) LIMIT least(greatest(p_limit,1),101)
) SELECT coalesce(jsonb_agg(item),'[]'::jsonb) FROM paged;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION resupply.pricing_alerts(uuid,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION resupply.pricing_alerts(uuid,integer,integer) TO service_role;
