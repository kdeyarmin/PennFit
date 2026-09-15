-- Created with the Supabase CLI, then placed in the ordered application migration directory.
-- Select the effective version first, then discard expired evidence. Filtering
-- inside DISTINCT ON would resurrect superseded prices or collection estimates.

CREATE OR REPLACE FUNCTION resupply.pricing_current_offers(p_org_id uuid,p_ids uuid[] DEFAULT NULL,p_sku text DEFAULT NULL,p_offset integer DEFAULT 0,p_limit integer DEFAULT 101) RETURNS SETOF resupply.pricing_offers
LANGUAGE sql SECURITY INVOKER STABLE SET search_path='' AS $$
 SELECT o.* FROM (SELECT DISTINCT ON(id) * FROM resupply.pricing_offers WHERE org_id=p_org_id AND effective_from<=statement_timestamp() AND (p_ids IS NULL OR id=ANY(p_ids)) AND (p_sku IS NULL OR sku=p_sku) ORDER BY id,version DESC) o WHERE o.expires_at>statement_timestamp() ORDER BY o.sku,o.id OFFSET greatest(p_offset,0) LIMIT least(greatest(p_limit,1),101);
$$;

CREATE OR REPLACE FUNCTION resupply.pricing_current_revenue_profiles(p_org_id uuid,p_patient_id uuid DEFAULT NULL,p_offset integer DEFAULT 0,p_limit integer DEFAULT 101) RETURNS SETOF resupply.pricing_revenue_profiles
LANGUAGE sql SECURITY INVOKER STABLE SET search_path='' AS $$
 SELECT r.* FROM (SELECT DISTINCT ON(id) * FROM resupply.pricing_revenue_profiles WHERE org_id=p_org_id AND effective_from<=statement_timestamp() AND (p_patient_id IS NULL OR patient_id=p_patient_id) ORDER BY id,version DESC) r WHERE r.expires_at>statement_timestamp() ORDER BY r.created_at DESC,r.id OFFSET greatest(p_offset,0) LIMIT least(greatest(p_limit,1),101);
$$;

-- Existing saved carrier quotes remain bound to their quoted service at approval/order binding.

CREATE OR REPLACE FUNCTION resupply.pricing_assert_quote_current(p_org_id uuid,p_quote_id uuid,p_revision integer) RETURNS resupply.pricing_quotes
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE s resupply.pricing_state%rowtype; q resupply.pricing_quotes%rowtype; p resupply.pricing_policies%rowtype;
BEGIN
  s:=resupply.pricing_lock_state(p_org_id);
  SELECT * INTO q FROM resupply.pricing_quotes WHERE org_id=p_org_id AND id=p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
  IF q.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='PT409'; END IF;
  IF q.valid_until<=clock_timestamp() OR NOT s.enabled OR q.policy_id IS DISTINCT FROM s.current_policy_id THEN RAISE EXCEPTION 'stale_dependencies' USING ERRCODE='PT409'; END IF;
  SELECT * INTO p FROM resupply.pricing_policies WHERE org_id=p_org_id AND id=q.policy_id;
  IF NOT FOUND OR p.version IS DISTINCT FROM q.policy_version OR p.effective_from>clock_timestamp() OR p.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'stale_dependencies' USING ERRCODE='PT409'; END IF;
  PERFORM resupply.pricing_assert_dependencies(p_org_id,q.dependencies);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(q.lines) line WHERE NOT EXISTS(SELECT 1 FROM resupply.products WHERE org_id=p_org_id AND sku=line->>'sku' AND active)) THEN RAISE EXCEPTION 'stale_dependencies' USING ERRCODE='PT409'; END IF;
  IF q.patient_id IS NOT NULL AND q.scenario ? 'deliveryAddressSnapshot' AND NOT EXISTS(SELECT 1 FROM resupply.patients WHERE org_id=p_org_id AND id=q.patient_id AND address IS NOT DISTINCT FROM nullif(q.scenario->'deliveryAddressSnapshot','null'::jsonb)) THEN RAISE EXCEPTION 'stale_dependencies' USING ERRCODE='PT409'; END IF;
  IF q.scenario->>'revenueProfileId' IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM (SELECT * FROM resupply.pricing_revenue_profiles WHERE org_id=p_org_id AND id=(q.scenario->>'revenueProfileId')::uuid AND effective_from<=clock_timestamp() ORDER BY version DESC LIMIT 1) rp
    WHERE rp.patient_id=q.patient_id AND rp.version=(q.scenario->>'revenueProfileVersion')::integer AND rp.expires_at>clock_timestamp()
  ) THEN RAISE EXCEPTION 'stale_dependencies' USING ERRCODE='PT409'; END IF;
  IF q.scenario->>'shippingQuoteId' IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM resupply.pricing_shipping_quotes shipping JOIN resupply.patients patient ON patient.org_id=shipping.org_id AND patient.id=q.patient_id
    WHERE shipping.org_id=p_org_id AND shipping.id=(q.scenario->>'shippingQuoteId')::uuid AND shipping.expires_at>clock_timestamp()
      AND shipping.data->'patientAddressSnapshot' IS NOT DISTINCT FROM patient.address
      AND nullif(shipping.data->>'service','') IS NOT NULL
      AND shipping.data->>'service'=q.scenario->'delivery'->>'service'
  ) THEN RAISE EXCEPTION 'stale_dependencies' USING ERRCODE='PT409'; END IF;
  RETURN q;
END; $$;

-- Future versions must not conceal an expiration gap or trigger cost alerts early.

CREATE OR REPLACE FUNCTION resupply.pricing_alerts(p_org_id uuid,p_offset integer DEFAULT 0,p_limit integer DEFAULT 101) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER STABLE SET search_path='' AS $$
WITH effective_offers AS (
 SELECT DISTINCT ON(id) * FROM resupply.pricing_offers WHERE org_id=p_org_id AND effective_from<=statement_timestamp() ORDER BY id,version DESC
), actuals AS (
 SELECT quote_id,sum(CASE kind WHEN 'cost' THEN amount_cents WHEN 'cost_credit' THEN -amount_cents ELSE 0 END) cost,sum(CASE kind WHEN 'revenue' THEN amount_cents WHEN 'refund' THEN -amount_cents ELSE 0 END) revenue
 FROM resupply.pricing_actual_events WHERE org_id=p_org_id GROUP BY quote_id
), signals AS (
 SELECT 'offer_expired' code,o.id entity_id,NULL::bigint amount,o.created_at,o.version::text discriminator FROM effective_offers o WHERE o.expires_at<=statement_timestamp()
 UNION ALL SELECT 'supplier_cost_increase',o.id,((o.data->>'unitCostCents')::bigint-(prior.data->>'unitCostCents')::bigint),o.created_at,o.version::text FROM effective_offers o JOIN LATERAL (
   SELECT * FROM resupply.pricing_offers candidate WHERE candidate.org_id=p_org_id AND candidate.id=o.id AND candidate.version<o.version AND candidate.effective_from<=statement_timestamp() ORDER BY candidate.version DESC LIMIT 1
 ) prior ON true WHERE (o.data->>'unitCostCents')::bigint>(prior.data->>'unitCostCents')::bigint
 UNION ALL SELECT 'quote_'||q.approval_class,q.id,NULL::bigint,q.updated_at,q.revision::text FROM resupply.pricing_quotes q WHERE q.org_id=p_org_id AND q.status='pending_approval'
 UNION ALL SELECT 'actual_cost_overrun',q.id,a.cost-(q.evaluation->>'totalVariableCostCents')::bigint,q.updated_at,q.actuals_revision::text FROM resupply.pricing_quotes q JOIN actuals a ON a.quote_id=q.id WHERE q.org_id=p_org_id AND a.cost>(q.evaluation->>'totalVariableCostCents')::bigint
 UNION ALL SELECT 'collection_shortfall',q.id,(q.evaluation->>'netRevenueCents')::bigint-a.revenue,q.updated_at,q.actuals_revision::text FROM resupply.pricing_quotes q JOIN actuals a ON a.quote_id=q.id WHERE q.org_id=p_org_id AND q.revenue_complete AND a.revenue<(q.evaluation->>'netRevenueCents')::bigint
 UNION ALL SELECT 'scheduled_activation_blocked',b.id,NULL::bigint,b.created_at,coalesce(b.scheduled_at::text,'') FROM resupply.pricing_price_lists b WHERE b.org_id=p_org_id AND b.schedule_status='blocked'
), keyed AS (SELECT *,md5(code||':'||entity_id::text||':'||discriminator) key FROM signals), paged AS (
 SELECT jsonb_build_object('key',k.key,'code',k.code,'entityId',k.entity_id,'amountCents',k.amount,'createdAt',k.created_at,'revision',coalesce(r.revision,0),'status',coalesce(r.status,'open'),'owner',coalesce(r.owner,''),'reviewAt',r.review_at,'notes',coalesce(r.notes,'')) item
 FROM keyed k LEFT JOIN resupply.pricing_alert_reviews r ON r.org_id=p_org_id AND r.key=k.key ORDER BY k.created_at DESC,k.key OFFSET greatest(p_offset,0) LIMIT least(greatest(p_limit,1),101)
) SELECT coalesce(jsonb_agg(item),'[]'::jsonb) FROM paged;
$$;

CREATE OR REPLACE FUNCTION resupply.pricing_apply_scheduled(p_org_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE s resupply.pricing_state%rowtype;b resupply.pricing_price_lists%rowtype;result jsonb;
BEGIN
  s:=resupply.pricing_lock_state(p_org_id);
  SELECT * INTO b FROM resupply.pricing_price_lists WHERE org_id=p_org_id AND schedule_status='pending' AND scheduled_at<=clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN null; END IF;
  BEGIN
    result:=resupply.pricing_mutate(p_org_id,b.created_by,'activate',jsonb_build_object('id',b.id,'expectedStateRevision',s.revision));
    UPDATE resupply.pricing_price_lists SET schedule_status='applied' WHERE org_id=p_org_id AND id=b.id;
  EXCEPTION WHEN OTHERS THEN
    -- Only deterministic pricing decisions permanently block a schedule.
    -- Serialization/deadlock, connectivity, permissions and unexpected database
    -- failures propagate unchanged: the transaction rolls back and stays pending.
    IF NOT (
      (SQLSTATE='PT409' AND SQLERRM IN ('stale_dependencies','revision_conflict','price_list_contexts_changed')) OR
      (SQLSTATE='22023' AND SQLERRM='blocked_pricing')
    ) THEN RAISE; END IF;
    UPDATE resupply.pricing_price_lists SET schedule_status='blocked',schedule_error=CASE WHEN SQLERRM='price_list_contexts_changed' THEN 'price_list_contexts_changed' WHEN SQLSTATE='PT409' THEN 'stale_dependencies' ELSE 'blocked_pricing' END WHERE org_id=p_org_id AND id=b.id;
    INSERT INTO resupply.pricing_events(org_id,entity_id,operation,actor,data) VALUES(p_org_id,b.id,'schedule_blocked',b.created_by,jsonb_build_object('code',SQLSTATE));
    RETURN jsonb_build_object('status','blocked');
  END;
  RETURN result;
END; $$;

REVOKE ALL ON FUNCTION resupply.pricing_current_offers(uuid,uuid[],text,integer,integer),resupply.pricing_current_revenue_profiles(uuid,uuid,integer,integer),resupply.pricing_assert_quote_current(uuid,uuid,integer),resupply.pricing_alerts(uuid,integer,integer),resupply.pricing_apply_scheduled(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION resupply.pricing_current_offers(uuid,uuid[],text,integer,integer),resupply.pricing_current_revenue_profiles(uuid,uuid,integer,integer),resupply.pricing_assert_quote_current(uuid,uuid,integer),resupply.pricing_alerts(uuid,integer,integer),resupply.pricing_apply_scheduled(uuid) TO service_role;

-- BEGIN CSR pricing deadline guards
-- A bound deadline is part of the accepted financial snapshot. Keeping it
-- immutable allows the order trigger to inspect it without reversing the
-- pricing writer lock order (state, quote, then order).
CREATE OR REPLACE FUNCTION resupply.guard_bound_pricing_deadline() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF OLD.status = 'bound' AND (
    NEW.valid_until IS DISTINCT FROM OLD.valid_until OR
    NEW.status IS DISTINCT FROM OLD.status OR
    NEW.bound_order_id IS DISTINCT FROM OLD.bound_order_id
  ) THEN
    RAISE EXCEPTION 'quote_already_bound' USING ERRCODE = 'PT409';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION resupply.guard_bound_pricing_deadline() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION resupply.guard_bound_pricing_deadline() TO service_role;
DROP TRIGGER IF EXISTS bound_pricing_deadline_guard ON resupply.pricing_quotes;
CREATE TRIGGER bound_pricing_deadline_guard BEFORE UPDATE OF valid_until, status, bound_order_id
  ON resupply.pricing_quotes FOR EACH ROW EXECUTE FUNCTION resupply.guard_bound_pricing_deadline();

CREATE OR REPLACE FUNCTION resupply.guard_csr_pricing_deadline() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE deadline timestamptz;
BEGIN
  -- Cancellation must still revoke expired links, and completed signatures
  -- remain historical records when later bookkeeping updates the order.
  IF OLD.pricing_quote_id IS NULL OR NEW.status = 'canceled' OR
     (OLD.status = 'signed' AND NEW.status = 'signed') THEN RETURN NEW; END IF;
  IF NEW.link_version IS NOT DISTINCT FROM OLD.link_version AND
     NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at AND
     NEW.status <> 'signed' THEN RETURN NEW; END IF;
  SELECT q.valid_until INTO deadline FROM resupply.pricing_quotes q
    WHERE q.org_id = NEW.org_id AND q.id = NEW.pricing_quote_id
      AND q.patient_id = NEW.patient_id AND q.status = 'bound'
      AND q.bound_order_id = NEW.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'quote_not_found' USING ERRCODE = 'PT409'; END IF;
  NEW.expires_at := least(coalesce(NEW.expires_at, deadline), deadline);
  IF NEW.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'quote_expired' USING ERRCODE = 'PT409';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION resupply.guard_csr_pricing_deadline() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION resupply.guard_csr_pricing_deadline() TO service_role;
DROP TRIGGER IF EXISTS csr_pricing_deadline_guard ON resupply.csr_order_requests;
CREATE TRIGGER csr_pricing_deadline_guard BEFORE UPDATE OF expires_at, link_version, status
  ON resupply.csr_order_requests FOR EACH ROW EXECUTE FUNCTION resupply.guard_csr_pricing_deadline();
-- END CSR pricing deadline guards
