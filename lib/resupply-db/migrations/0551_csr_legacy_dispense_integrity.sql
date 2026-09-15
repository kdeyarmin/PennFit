-- Created with the Supabase CLI and placed in the ordered migration tree.
-- Legacy draft IDs are not episode IDs. Resolve the exact ordered item and
-- a real prescription before creating the episode/fulfillment atomically.
CREATE OR REPLACE FUNCTION resupply.dispense_csr_legacy_order(p_org_id uuid,p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,resupply AS $$
DECLARE
  o resupply.csr_order_requests%ROWTYPE;
  d resupply.resupply_order_drafts%ROWTYPE;
  line jsonb; lines jsonb := '[]'; ids jsonb; v_sku text; method text;
  quantity integer; rx uuid; episode uuid; fulfillment uuid; position integer := 0;
BEGIN
  SELECT * INTO o FROM resupply.csr_order_requests WHERE org_id=p_org_id AND id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','not_found'); END IF;
  IF o.pricing_quote_id IS NOT NULL THEN RETURN resupply.dispense_csr_priced_order(p_org_id,p_order_id); END IF;
  IF o.status<>'signed' THEN RETURN jsonb_build_object('status','not_signed'); END IF;
  SELECT * INTO d FROM resupply.resupply_order_drafts WHERE org_id=p_org_id AND csr_order_request_id=p_order_id ORDER BY id LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','no_draft'); END IF;
  IF d.patient_id IS NULL OR NOT EXISTS(SELECT 1 FROM resupply.patients WHERE org_id=p_org_id AND id=d.patient_id) THEN RETURN jsonb_build_object('status','no_patient'); END IF;
  IF o.patient_id IS NOT NULL AND o.patient_id<>d.patient_id THEN RAISE EXCEPTION 'draft_patient_mismatch' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM resupply.csr_compliance_alerts WHERE org_id=p_org_id AND patient_id=d.patient_id AND alert_type='address_change_pending' AND status='open') THEN RETURN jsonb_build_object('status','address_hold'); END IF;
  SELECT jsonb_agg(id ORDER BY csr_order_line_id) INTO ids FROM resupply.fulfillments WHERE org_id=p_org_id AND csr_order_request_id=p_order_id;
  IF ids IS NOT NULL THEN RETURN jsonb_build_object('status','queued','fulfillmentIds',ids,'replayed',true); END IF;
  IF jsonb_typeof(o.items)<>'array' OR jsonb_array_length(o.items) NOT BETWEEN 1 AND 20 THEN RETURN jsonb_build_object('status','no_sku'); END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(o.items) LOOP
    position:=position+1;
    v_sku:=nullif(btrim(line->>'sku'),'');
    IF v_sku IS NULL AND jsonb_array_length(o.items)=1 THEN v_sku:=nullif(btrim(d.suggested_product_id),''); END IF;
    -- A broad supply category is not an exact SKU and cannot be substituted.
    IF v_sku IS NULL OR NOT EXISTS(SELECT 1 FROM resupply.products p WHERE p.org_id=p_org_id AND p.sku=v_sku AND p.active) THEN RETURN jsonb_build_object('status','no_sku'); END IF;
    quantity:=(line->>'quantity')::integer;
    IF quantity IS NULL OR quantity NOT BETWEEN 1 AND 99 THEN RETURN jsonb_build_object('status','no_sku'); END IF;
    method:=coalesce(line->>'fulfillmentMethod','stock');
    IF method NOT IN ('stock','dropship') THEN RETURN jsonb_build_object('status','no_sku'); END IF;
    SELECT p.id INTO rx FROM resupply.prescriptions p WHERE p.org_id=p_org_id AND p.patient_id=d.patient_id AND p.item_sku=v_sku AND p.status='active' AND p.valid_from<=CURRENT_DATE AND (p.valid_until IS NULL OR p.valid_until>=CURRENT_DATE) ORDER BY p.valid_from DESC,p.id LIMIT 1;
    IF rx IS NULL THEN RETURN jsonb_build_object('status','needs_prescription'); END IF;
    lines:=lines||jsonb_build_array(jsonb_build_object('sku',v_sku,'quantity',quantity,'rx',rx,'method',method,'lineId',coalesce(line->>'lineId','legacy:'||position::text)));
  END LOOP;
  UPDATE resupply.csr_order_requests SET patient_id=d.patient_id WHERE org_id=p_org_id AND id=p_order_id;
  ids:='[]';
  FOR line IN SELECT value FROM jsonb_array_elements(lines) LOOP
    episode:=gen_random_uuid(); fulfillment:=gen_random_uuid();
    INSERT INTO resupply.episodes(id,org_id,patient_id,prescription_id,status,due_at,metadata)
      VALUES(episode,p_org_id,d.patient_id,(line->>'rx')::uuid,'confirmed',now(),jsonb_build_object('csrOrderRequestId',p_order_id,'resupplyDraftId',d.id,'csrOrderLineId',line->>'lineId'));
    INSERT INTO resupply.fulfillments(id,org_id,patient_id,episode_id,item_sku,quantity,status,csr_order_request_id,csr_order_line_id,fulfillment_method)
      VALUES(fulfillment,p_org_id,d.patient_id,episode,line->>'sku',(line->>'quantity')::integer,'queued',p_order_id,line->>'lineId',line->>'method');
    IF line->>'method'='stock' THEN
    BEGIN
      PERFORM resupply.adjust_product_stock(p_org_id,line->>'sku',-(line->>'quantity')::integer,'dispense',fulfillment::text,'Signed CSR resupply order',o.created_by_email);
    EXCEPTION WHEN no_data_found OR check_violation THEN
      UPDATE resupply.fulfillments SET shipment_metadata=shipment_metadata||'{"inventoryReviewRequired":true}'::jsonb WHERE org_id=p_org_id AND id=fulfillment;
    END;
    END IF;
    ids:=ids||jsonb_build_array(fulfillment);
  END LOOP;
  RETURN jsonb_build_object('status','queued','fulfillmentIds',ids,'replayed',false);
END; $$;
REVOKE ALL ON FUNCTION resupply.dispense_csr_legacy_order(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION resupply.dispense_csr_legacy_order(uuid,uuid) TO service_role;
