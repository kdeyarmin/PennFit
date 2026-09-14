-- Created with supabase migration new csr_delivery_reviews; ordered repository name.
-- Delivery reviews are separate forecasts. The signed items and original quote
-- remain the commitment and the baseline for actual-vs-quoted reporting.
CREATE TABLE resupply.csr_delivery_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES resupply.organizations(id),
  order_id uuid NOT NULL REFERENCES resupply.csr_order_requests(id),
  quote_id uuid NOT NULL, quote_revision integer NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK(revision=1),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved')),
  data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'), address_snapshot jsonb NOT NULL,
  valid_until timestamptz NOT NULL, approved_at timestamptz, approved_by text, reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), created_by text NOT NULL,
  FOREIGN KEY(org_id,quote_id) REFERENCES resupply.pricing_quotes(org_id,id),
  UNIQUE(org_id,id)
);
CREATE INDEX csr_delivery_reviews_order_idx ON resupply.csr_delivery_reviews(org_id,order_id,created_at DESC,id);
ALTER TABLE resupply.csr_delivery_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY csr_delivery_tenant ON resupply.csr_delivery_reviews
  USING(org_id=nullif(current_setting('app.current_org_id',true),'')::uuid)
  WITH CHECK(org_id=nullif(current_setting('app.current_org_id',true),'')::uuid);
REVOKE ALL ON resupply.csr_delivery_reviews FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON resupply.csr_delivery_reviews TO service_role;
--> statement-breakpoint
-- Any staff/API address edit holds priced work that has not left the queue,
-- even when no patient-message address alert was created. The patient update
-- already owns the same row lock used by delivery approval/dispensing.
CREATE FUNCTION resupply.hold_priced_orders_on_address_change()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,resupply AS $$
BEGIN
  UPDATE resupply.fulfillments SET status='on_hold',updated_at=clock_timestamp(),
    shipment_metadata=coalesce(shipment_metadata,'{}'::jsonb)||jsonb_build_object(
      'deliveryHoldReason','patient_address_changed','deliveryHoldActive',true,'deliveryHoldAt',clock_timestamp())
    WHERE org_id=NEW.org_id AND patient_id=NEW.id AND pricing_quote_id IS NOT NULL
      AND status='queued' AND submitted_at IS NULL AND shipped_at IS NULL;
  RETURN NEW;
END; $$;
CREATE TRIGGER hold_priced_orders_on_address_change AFTER UPDATE OF address ON resupply.patients
  FOR EACH ROW WHEN (OLD.address IS DISTINCT FROM NEW.address)
  EXECUTE FUNCTION resupply.hold_priced_orders_on_address_change();
REVOKE ALL ON FUNCTION resupply.hold_priced_orders_on_address_change() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION resupply.hold_priced_orders_on_address_change() TO service_role;
--> statement-breakpoint
CREATE FUNCTION resupply.save_csr_delivery_review(p_org_id uuid,p_order_id uuid,p_actor text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,resupply AS $$
DECLARE o resupply.csr_order_requests%rowtype; q resupply.pricing_quotes%rowtype;
  original_terms jsonb; reviewed_terms jsonb; address jsonb; v_id uuid;
BEGIN
  PERFORM resupply.pricing_lock_state(p_org_id);
  SELECT * INTO o FROM resupply.csr_order_requests WHERE org_id=p_org_id AND id=p_order_id FOR UPDATE;
  IF NOT FOUND OR o.status<>'signed' OR o.pricing_quote_id IS NULL THEN
    RAISE EXCEPTION 'signed_priced_order_required' USING ERRCODE='40001'; END IF;
  SELECT * INTO q FROM resupply.pricing_quotes WHERE org_id=p_org_id AND id=o.pricing_quote_id AND status='bound' AND bound_order_id=o.id;
  IF NOT FOUND OR q.patient_id IS DISTINCT FROM o.patient_id OR q.revision IS DISTINCT FROM (p_payload->>'quoteRevision')::integer THEN
    RAISE EXCEPTION 'delivery_terms_changed' USING ERRCODE='40001'; END IF;
  SELECT patient.address INTO address FROM resupply.patients patient WHERE patient.org_id=p_org_id AND patient.id=o.patient_id FOR UPDATE;
  IF address IS NULL OR address IS DISTINCT FROM p_payload->'addressSnapshot' THEN
    RAISE EXCEPTION 'delivery_snapshot_changed' USING ERRCODE='40001'; END IF;
  PERFORM 1 FROM resupply.fulfillments WHERE org_id=p_org_id AND csr_order_request_id=p_order_id ORDER BY id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM resupply.fulfillments WHERE org_id=p_org_id AND csr_order_request_id=p_order_id
    AND (status NOT IN ('queued','on_hold') OR submitted_at IS NOT NULL OR shipped_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'delivery_already_in_progress' USING ERRCODE='40001'; END IF;
  SELECT jsonb_agg(jsonb_build_array(l->>'id',l->>'sku',l->>'quantity',l->>'unitAmountCents',l->>'fulfillmentMethod') ORDER BY l->>'id')
    INTO original_terms FROM jsonb_array_elements(q.scenario->'lines') l;
  SELECT jsonb_agg(jsonb_build_array(l->>'id',l->>'sku',l->>'quantity',l->>'unitAmountCents',l->>'fulfillmentMethod') ORDER BY l->>'id')
    INTO reviewed_terms FROM jsonb_array_elements(p_payload->'scenario'->'lines') l;
  IF original_terms IS NULL OR original_terms IS DISTINCT FROM reviewed_terms
    OR q.input->'revenue'->>'mode' IS DISTINCT FROM 'insurance'
    OR p_payload->'input'->'revenue'->>'mode' IS DISTINCT FROM 'insurance'
    OR q.input->'revenue'->>'expectedCollectibleCents' IS DISTINCT FROM p_payload->'input'->'revenue'->>'expectedCollectibleCents'
    OR q.patient_id IS DISTINCT FROM (p_payload->'scenario'->>'patientId')::uuid THEN
    RAISE EXCEPTION 'delivery_terms_changed' USING ERRCODE='40001'; END IF;
  IF (p_payload->>'validUntil')::timestamptz<=clock_timestamp() THEN
    RAISE EXCEPTION 'delivery_review_expired' USING ERRCODE='40001'; END IF;
  INSERT INTO resupply.csr_delivery_reviews(org_id,order_id,quote_id,quote_revision,data,address_snapshot,valid_until,created_by)
    VALUES(p_org_id,o.id,q.id,q.revision,p_payload,address,(p_payload->>'validUntil')::timestamptz,p_actor) RETURNING id INTO v_id;
  RETURN jsonb_build_object('id',v_id);
END; $$;
--> statement-breakpoint
-- A reviewed address is usable only until its short delivery estimate expires.
-- Old approvals cannot release a later address change, even for the same order.
CREATE FUNCTION resupply.csr_order_delivery_allowed(p_org_id uuid,p_order_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,resupply AS $$
DECLARE o resupply.csr_order_requests%rowtype; q resupply.pricing_quotes%rowtype;
  address jsonb; r resupply.csr_delivery_reviews%rowtype;
BEGIN
  SELECT * INTO o FROM resupply.csr_order_requests WHERE org_id=p_org_id AND id=p_order_id;
  IF NOT FOUND OR o.status<>'signed' OR o.pricing_quote_id IS NULL OR o.patient_id IS NULL THEN RETURN false; END IF;
  SELECT * INTO q FROM resupply.pricing_quotes WHERE org_id=p_org_id AND id=o.pricing_quote_id;
  IF NOT FOUND OR q.status<>'bound' OR q.bound_order_id IS DISTINCT FROM o.id OR q.patient_id IS DISTINCT FROM o.patient_id THEN RETURN false; END IF;
  SELECT patient.address INTO address FROM resupply.patients patient WHERE patient.org_id=p_org_id AND patient.id=o.patient_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM resupply.csr_compliance_alerts WHERE org_id=p_org_id AND patient_id=o.patient_id
    AND alert_type='address_change_pending' AND status='open') THEN RETURN false; END IF;
  SELECT * INTO r FROM resupply.csr_delivery_reviews WHERE org_id=p_org_id AND order_id=o.id AND status='approved' ORDER BY approved_at DESC,id DESC LIMIT 1;
  IF FOUND THEN RETURN r.address_snapshot IS NOT DISTINCT FROM address AND r.valid_until>clock_timestamp(); END IF;
  IF q.scenario ? 'deliveryAddressSnapshot' AND address IS DISTINCT FROM nullif(q.scenario->'deliveryAddressSnapshot','null'::jsonb) THEN RETURN false; END IF;
  IF q.scenario->>'shippingQuoteId' IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM resupply.pricing_shipping_quotes WHERE org_id=p_org_id AND id=(q.scenario->>'shippingQuoteId')::uuid
      AND data->'patientAddressSnapshot' IS NOT DISTINCT FROM address) THEN RETURN false; END IF;
  RETURN true;
END; $$;
--> statement-breakpoint
-- The warehouse export can check its selected episodes in one tenant-scoped
-- request. Missing/held/in-progress priced fulfillment is never exportable.
CREATE FUNCTION resupply.csr_pricing_held_episode_ids(p_org_id uuid,p_episode_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,resupply AS $$
DECLARE result jsonb;
BEGIN
  IF p_episode_ids IS NULL OR cardinality(p_episode_ids)>10000 THEN
    RAISE EXCEPTION 'invalid_episode_batch' USING ERRCODE='22023'; END IF;
  SELECT coalesce(jsonb_agg(e.id ORDER BY e.id),'[]'::jsonb) INTO result
    FROM resupply.episodes e WHERE e.org_id=p_org_id AND e.id=ANY(p_episode_ids)
      AND (e.metadata->>'pricingQuoteId' IS NOT NULL OR EXISTS(
        SELECT 1 FROM resupply.fulfillments f WHERE f.org_id=p_org_id AND f.episode_id=e.id AND f.pricing_quote_id IS NOT NULL))
      AND (NOT EXISTS(SELECT 1 FROM resupply.fulfillments f WHERE f.org_id=p_org_id AND f.episode_id=e.id AND f.pricing_quote_id IS NOT NULL)
        OR EXISTS(SELECT 1 FROM resupply.fulfillments f WHERE f.org_id=p_org_id AND f.episode_id=e.id
          AND (f.pricing_quote_id IS NULL OR f.status<>'queued' OR f.submitted_at IS NOT NULL OR f.shipped_at IS NOT NULL
            OR f.patient_id IS DISTINCT FROM e.patient_id
            OR (e.metadata->>'pricingQuoteId' IS NOT NULL AND e.metadata->>'pricingQuoteId' IS DISTINCT FROM f.pricing_quote_id::text)
            OR (e.metadata->>'csrOrderRequestId' IS NOT NULL AND e.metadata->>'csrOrderRequestId' IS DISTINCT FROM f.csr_order_request_id::text)
            OR NOT resupply.csr_order_delivery_allowed(p_org_id,f.csr_order_request_id))));
  RETURN result;
END; $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resupply.dispense_csr_priced_order(p_org_id uuid,p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,resupply AS $$
DECLARE o resupply.csr_order_requests%rowtype; q resupply.pricing_quotes%rowtype;
  line jsonb; prescription uuid; episode uuid; fulfillment uuid; method text;
  ids jsonb:='[]'::jsonb; existing jsonb;
BEGIN
  SELECT * INTO o FROM resupply.csr_order_requests WHERE org_id=p_org_id AND id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','not_found'); END IF;
  IF o.pricing_quote_id IS NULL THEN RETURN jsonb_build_object('status','no_pricing_quote'); END IF;
  IF o.status<>'signed' THEN RETURN jsonb_build_object('status','not_signed'); END IF;
  SELECT * INTO q FROM resupply.pricing_quotes WHERE org_id=p_org_id AND id=o.pricing_quote_id AND bound_order_id=o.id AND status='bound';
  IF NOT FOUND OR q.patient_id IS DISTINCT FROM o.patient_id THEN RAISE EXCEPTION 'pricing_order_snapshot_mismatch' USING ERRCODE='23514'; END IF;
  -- Lock the actual address before release/creation; an address edit serializes here.
  PERFORM 1 FROM resupply.patients WHERE org_id=p_org_id AND id=o.patient_id FOR UPDATE;
  PERFORM 1 FROM resupply.fulfillments WHERE org_id=p_org_id AND csr_order_request_id=o.id ORDER BY id FOR UPDATE;
  SELECT jsonb_agg(id ORDER BY csr_order_line_id) INTO existing FROM resupply.fulfillments WHERE org_id=p_org_id AND csr_order_request_id=o.id;
  IF existing IS NOT NULL THEN
    IF jsonb_array_length(existing)<>jsonb_array_length(q.lines) THEN RAISE EXCEPTION 'pricing_order_partial_fulfillment' USING ERRCODE='23514'; END IF;
    IF EXISTS(SELECT 1 FROM resupply.fulfillments WHERE org_id=p_org_id AND csr_order_request_id=o.id AND status='on_hold') THEN
      RETURN jsonb_build_object('status','address_hold','fulfillmentIds',existing,'replayed',true);
    END IF;
    -- A retry does not recreate or move stock for already submitted/shipped rows.
    IF EXISTS(SELECT 1 FROM resupply.fulfillments WHERE org_id=p_org_id AND csr_order_request_id=o.id AND status='queued')
      AND NOT resupply.csr_order_delivery_allowed(p_org_id,o.id) THEN
      RETURN jsonb_build_object('status','address_hold','fulfillmentIds',existing,'replayed',true);
    END IF;
    RETURN jsonb_build_object('status','queued','fulfillmentIds',existing,'replayed',true);
  END IF;
  IF NOT resupply.csr_order_delivery_allowed(p_org_id,o.id) THEN RETURN jsonb_build_object('status','address_hold'); END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(q.lines) LOOP
    IF NOT EXISTS(SELECT 1 FROM resupply.prescriptions WHERE org_id=p_org_id AND patient_id=o.patient_id AND item_sku=line->>'sku'
      AND status='active' AND valid_from<=CURRENT_DATE AND (valid_until IS NULL OR valid_until>=CURRENT_DATE)) THEN
      RETURN jsonb_build_object('status','needs_prescription'); END IF;
  END LOOP;
  FOR line IN SELECT value FROM jsonb_array_elements(q.lines) LOOP
    SELECT id INTO STRICT prescription FROM resupply.prescriptions WHERE org_id=p_org_id AND patient_id=o.patient_id
      AND item_sku=line->>'sku' AND status='active' AND valid_from<=CURRENT_DATE AND (valid_until IS NULL OR valid_until>=CURRENT_DATE)
      ORDER BY valid_from DESC,id LIMIT 1;
    episode:=gen_random_uuid(); fulfillment:=gen_random_uuid(); method:=coalesce(line->>'fulfillmentMethod','stock');
    INSERT INTO resupply.episodes(id,org_id,patient_id,prescription_id,status,due_at,metadata)
      VALUES(episode,p_org_id,o.patient_id,prescription,'confirmed',now(),jsonb_build_object('csrOrderRequestId',o.id,'pricingQuoteId',q.id,'csrOrderLineId',line->>'id'));
    INSERT INTO resupply.fulfillments(id,org_id,patient_id,episode_id,item_sku,quantity,status,csr_order_request_id,csr_order_line_id,pricing_quote_id,pricing_unit_cost_cents,fulfillment_method,pricing_snapshot)
      VALUES(fulfillment,p_org_id,o.patient_id,episode,line->>'sku',(line->>'quantity')::integer,'queued',o.id,line->>'id',q.id,(line->>'unitCostCents')::integer,method,line);
    IF method='stock' THEN
      BEGIN
        PERFORM resupply.adjust_product_stock(p_org_id,line->>'sku',-(line->>'quantity')::integer,'dispense',fulfillment::text,'Approved CSR order',o.created_by_email);
      EXCEPTION WHEN no_data_found OR check_violation THEN
        UPDATE resupply.fulfillments SET shipment_metadata=shipment_metadata||'{"inventoryReviewRequired":true}'::jsonb WHERE org_id=p_org_id AND id=fulfillment;
      END;
    END IF;
    ids:=ids||jsonb_build_array(fulfillment);
  END LOOP;
  RETURN jsonb_build_object('status','queued','fulfillmentIds',ids,'replayed',false);
END; $$;
--> statement-breakpoint
CREATE FUNCTION resupply.approve_csr_delivery_review(p_org_id uuid,p_order_id uuid,p_review_id uuid,p_actor text,p_revision integer,p_reason text,p_allow_exception boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,resupply AS $$
DECLARE s resupply.pricing_state%rowtype; o resupply.csr_order_requests%rowtype;
  r resupply.csr_delivery_reviews%rowtype; address jsonb; result jsonb;
BEGIN
  s:=resupply.pricing_lock_state(p_org_id);
  SELECT * INTO o FROM resupply.csr_order_requests WHERE org_id=p_org_id AND id=p_order_id FOR UPDATE;
  IF NOT FOUND OR o.status<>'signed' OR o.pricing_quote_id IS NULL THEN RAISE EXCEPTION 'signed_priced_order_required' USING ERRCODE='40001'; END IF;
  SELECT * INTO r FROM resupply.csr_delivery_reviews WHERE org_id=p_org_id AND id=p_review_id AND order_id=o.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'delivery_review_not_found' USING ERRCODE='40001'; END IF;
  IF r.quote_id IS DISTINCT FROM o.pricing_quote_id OR NOT EXISTS(
    SELECT 1 FROM resupply.pricing_quotes WHERE org_id=p_org_id AND id=r.quote_id
      AND revision=r.quote_revision AND status='bound' AND bound_order_id=o.id AND patient_id=o.patient_id) THEN
    RAISE EXCEPTION 'delivery_terms_changed' USING ERRCODE='40001'; END IF;
  IF r.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001'; END IF;
  SELECT patient.address INTO address FROM resupply.patients patient WHERE patient.org_id=p_org_id AND patient.id=o.patient_id FOR UPDATE;
  IF address IS DISTINCT FROM r.address_snapshot THEN RAISE EXCEPTION 'delivery_snapshot_changed' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM resupply.csr_delivery_reviews WHERE org_id=p_org_id AND order_id=o.id AND status='approved'
    AND id<>r.id AND approved_at>coalesce(r.approved_at,r.created_at)) THEN RAISE EXCEPTION 'delivery_review_superseded' USING ERRCODE='40001'; END IF;
  IF r.status='approved' THEN
    result:=resupply.dispense_csr_priced_order(p_org_id,o.id);
    RETURN result||'{"replayed":true}'::jsonb;
  END IF;
  IF r.valid_until<=clock_timestamp() THEN RAISE EXCEPTION 'delivery_review_expired' USING ERRCODE='40001'; END IF;
  IF length(trim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'delivery_review_reason_required' USING ERRCODE='22023'; END IF;
  IF r.data->>'approvalClass' IS NULL OR r.data->>'approvalClass' NOT IN ('firm','exception')
    OR (r.data->>'approvalClass'='exception' AND p_allow_exception IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'blocked_pricing' USING ERRCODE='22023'; END IF;
  IF NOT s.enabled OR s.current_policy_id IS DISTINCT FROM (r.data->>'policyId')::uuid OR NOT EXISTS(
    SELECT 1 FROM resupply.pricing_policies WHERE org_id=p_org_id AND id=s.current_policy_id
      AND version=(r.data->>'policyVersion')::integer AND effective_from<=clock_timestamp() AND expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'stale_dependencies' USING ERRCODE='40001'; END IF;
  PERFORM resupply.pricing_assert_dependencies(p_org_id,r.data->'dependencies');
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(r.data->'scenario'->'lines') line
    WHERE NOT EXISTS(SELECT 1 FROM resupply.products WHERE org_id=p_org_id AND sku=line->>'sku' AND active)) THEN
    RAISE EXCEPTION 'stale_dependencies' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM resupply.csr_compliance_alerts WHERE org_id=p_org_id AND patient_id=o.patient_id
    AND alert_type='address_change_pending' AND status='open') THEN RAISE EXCEPTION 'address_change_pending' USING ERRCODE='40001'; END IF;
  PERFORM 1 FROM resupply.fulfillments WHERE org_id=p_org_id AND csr_order_request_id=o.id ORDER BY id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM resupply.fulfillments WHERE org_id=p_org_id AND csr_order_request_id=o.id
    AND (status NOT IN ('queued','on_hold') OR submitted_at IS NOT NULL OR shipped_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'delivery_already_in_progress' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(r.data->'scenario'->'lines') line WHERE NOT EXISTS(
    SELECT 1 FROM resupply.prescriptions WHERE org_id=p_org_id AND patient_id=o.patient_id
      AND item_sku=line->>'sku' AND status='active' AND valid_from<=CURRENT_DATE
      AND (valid_until IS NULL OR valid_until>=CURRENT_DATE))) THEN
    RETURN jsonb_build_object('status','needs_prescription','fulfillmentIds','[]'::jsonb);
  END IF;
  UPDATE resupply.csr_delivery_reviews SET status='approved',approved_at=clock_timestamp(),approved_by=p_actor,reason=p_reason WHERE org_id=p_org_id AND id=r.id;
  UPDATE resupply.fulfillments SET status='queued',updated_at=clock_timestamp(),
    shipment_metadata=coalesce(shipment_metadata,'{}'::jsonb)||jsonb_build_object('deliveryReviewId',r.id,'deliveryHoldActive',false)
    WHERE org_id=p_org_id AND csr_order_request_id=o.id AND status='on_hold';
  result:=resupply.dispense_csr_priced_order(p_org_id,o.id);
  UPDATE resupply.fulfillments SET shipment_metadata=coalesce(shipment_metadata,'{}'::jsonb)||jsonb_build_object('deliveryReviewId',r.id)
    WHERE org_id=p_org_id AND csr_order_request_id=o.id AND status='queued';
  INSERT INTO resupply.pricing_events(org_id,entity_id,operation,actor,data)
    VALUES(p_org_id,o.pricing_quote_id,'delivery.approved',p_actor,jsonb_build_object('orderId',o.id,'deliveryReviewId',r.id,'reason',p_reason));
  RETURN result;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resupply.save_csr_delivery_review(uuid,uuid,text,jsonb),resupply.csr_order_delivery_allowed(uuid,uuid),resupply.csr_pricing_held_episode_ids(uuid,uuid[]),resupply.approve_csr_delivery_review(uuid,uuid,uuid,text,integer,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION resupply.save_csr_delivery_review(uuid,uuid,text,jsonb),resupply.csr_order_delivery_allowed(uuid,uuid),resupply.csr_pricing_held_episode_ids(uuid,uuid[]),resupply.approve_csr_delivery_review(uuid,uuid,uuid,text,integer,text,boolean) TO service_role;
