-- Created with the Supabase CLI, then placed in the repository's ordered
-- migration directory. Quotes retain private economics; signature items
-- carry only the approved customer-facing line identity and amounts.
-- Preserve exact product COGS when one dispensed pack maps to several
-- billed HCPCS units. A fractional cent per billed unit is never rounded
-- into a different total cost.
ALTER TABLE resupply.insurance_claim_line_items
  ADD COLUMN IF NOT EXISTS extended_cost_cents bigint CHECK (extended_cost_cents >= 0);
--> statement-breakpoint
ALTER TABLE resupply.csr_order_requests
  ADD COLUMN IF NOT EXISTS patient_id uuid REFERENCES resupply.patients(id),
  ADD COLUMN IF NOT EXISTS pricing_quote_id uuid REFERENCES resupply.pricing_quotes(id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS csr_order_requests_pricing_quote_idx
  ON resupply.csr_order_requests (org_id, pricing_quote_id)
  WHERE pricing_quote_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE resupply.fulfillments
  ADD COLUMN IF NOT EXISTS csr_order_request_id uuid REFERENCES resupply.csr_order_requests(id),
  ADD COLUMN IF NOT EXISTS csr_order_line_id text,
  ADD COLUMN IF NOT EXISTS pricing_quote_id uuid REFERENCES resupply.pricing_quotes(id),
  ADD COLUMN IF NOT EXISTS pricing_unit_cost_cents integer CHECK (pricing_unit_cost_cents >= 0),
  ADD COLUMN IF NOT EXISTS fulfillment_method text CHECK (fulfillment_method IN ('stock', 'dropship')),
  ADD COLUMN IF NOT EXISTS pricing_snapshot jsonb;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS fulfillments_csr_pricing_line_idx
  ON resupply.fulfillments (org_id, csr_order_request_id, csr_order_line_id)
  WHERE csr_order_request_id IS NOT NULL AND csr_order_line_id IS NOT NULL;
--> statement-breakpoint

-- One signed, priced order is dispensed in one transaction. We lock the
-- order before inserting any lines, preventing retries/concurrent signing
-- from creating duplicate fulfillments or moving stock twice. The cost
-- snapshot remains the approved snapshot even if supplier prices change.
CREATE OR REPLACE FUNCTION resupply.dispense_csr_priced_order(
  p_org_id uuid, p_order_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, resupply
AS $$
DECLARE
  v_order resupply.csr_order_requests%ROWTYPE;
  v_quote resupply.pricing_quotes%ROWTYPE;
  v_line jsonb;
  v_prescription uuid;
  v_episode uuid;
  v_fulfillment uuid;
  v_ids jsonb := '[]'::jsonb;
  v_existing jsonb;
  v_method text;
BEGIN
  SELECT * INTO v_order FROM resupply.csr_order_requests
    WHERE org_id = p_org_id AND id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v_order.pricing_quote_id IS NULL THEN
    RETURN jsonb_build_object('status', 'no_pricing_quote');
  END IF;
  IF v_order.status <> 'signed' THEN
    RETURN jsonb_build_object('status', 'not_signed');
  END IF;
  SELECT * INTO v_quote FROM resupply.pricing_quotes
    WHERE org_id = p_org_id AND id = v_order.pricing_quote_id
      AND bound_order_id = p_order_id AND status = 'bound';
  IF NOT FOUND OR v_quote.patient_id IS DISTINCT FROM v_order.patient_id THEN
    RAISE EXCEPTION 'pricing_order_snapshot_mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT jsonb_agg(id ORDER BY csr_order_line_id) INTO v_existing
    FROM resupply.fulfillments
    WHERE org_id = p_org_id AND csr_order_request_id = p_order_id;
  IF v_existing IS NOT NULL THEN
    IF jsonb_array_length(v_existing) <> jsonb_array_length(v_quote.lines) THEN
      RAISE EXCEPTION 'pricing_order_partial_fulfillment' USING ERRCODE = '23514';
    END IF;
    RETURN jsonb_build_object('status', 'queued', 'fulfillmentIds', v_existing, 'replayed', true);
  END IF;

  IF EXISTS (SELECT 1 FROM resupply.csr_compliance_alerts
    WHERE org_id = p_org_id AND patient_id = v_order.patient_id
      AND alert_type = 'address_change_pending' AND status = 'open') THEN
    RETURN jsonb_build_object('status', 'address_hold');
  END IF;
  IF v_quote.scenario ? 'deliveryAddressSnapshot' AND NOT EXISTS (
    SELECT 1 FROM resupply.patients WHERE org_id=p_org_id AND id=v_order.patient_id
      AND address IS NOT DISTINCT FROM v_quote.scenario->'deliveryAddressSnapshot'
  ) THEN RETURN jsonb_build_object('status','address_hold'); END IF;
  IF v_quote.scenario->>'shippingQuoteId' IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM resupply.pricing_shipping_quotes shipping
    JOIN resupply.patients patient ON patient.org_id=shipping.org_id AND patient.id=v_order.patient_id
    WHERE shipping.org_id=p_org_id AND shipping.id=(v_quote.scenario->>'shippingQuoteId')::uuid
      AND shipping.data->'patientAddressSnapshot' IS NOT DISTINCT FROM patient.address
  ) THEN RETURN jsonb_build_object('status', 'address_hold'); END IF;

  -- Validate every clinical link before creating any work. A financial
  -- quote cannot invent a prescription or select an unapproved substitute.
  FOR v_line IN SELECT value FROM jsonb_array_elements(v_quote.lines) LOOP
    IF NOT EXISTS (SELECT 1 FROM resupply.prescriptions
      WHERE org_id = p_org_id AND patient_id = v_order.patient_id
        AND item_sku = v_line->>'sku' AND status = 'active'
        AND valid_from <= CURRENT_DATE
        AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)) THEN
      RETURN jsonb_build_object('status', 'needs_prescription');
    END IF;
  END LOOP;

  FOR v_line IN SELECT value FROM jsonb_array_elements(v_quote.lines) LOOP
    SELECT id INTO STRICT v_prescription FROM resupply.prescriptions
      WHERE org_id = p_org_id AND patient_id = v_order.patient_id
        AND item_sku = v_line->>'sku' AND status = 'active'
        AND valid_from <= CURRENT_DATE
        AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)
      ORDER BY valid_from DESC, id LIMIT 1;
    v_episode := gen_random_uuid();
    INSERT INTO resupply.episodes (id, org_id, patient_id, prescription_id, status, due_at, metadata)
      VALUES (v_episode, p_org_id, v_order.patient_id, v_prescription, 'confirmed', now(),
        jsonb_build_object('csrOrderRequestId', p_order_id, 'pricingQuoteId', v_quote.id,
          'csrOrderLineId', v_line->>'id'));
    v_fulfillment := gen_random_uuid();
    v_method := COALESCE(v_line->>'fulfillmentMethod', 'stock');
    INSERT INTO resupply.fulfillments (id, org_id, patient_id, episode_id, item_sku,
      quantity, status, csr_order_request_id, csr_order_line_id, pricing_quote_id,
      pricing_unit_cost_cents, fulfillment_method, pricing_snapshot)
      VALUES (v_fulfillment, p_org_id, v_order.patient_id, v_episode, v_line->>'sku',
        (v_line->>'quantity')::integer, 'queued', p_order_id, v_line->>'id', v_quote.id,
        (v_line->>'unitCostCents')::integer, v_method, v_line);

    IF v_method = 'stock' THEN
      BEGIN
        PERFORM resupply.adjust_product_stock(p_org_id, v_line->>'sku',
          -(v_line->>'quantity')::integer, 'dispense', v_fulfillment::text,
          'Approved CSR order', v_order.created_by_email);
      EXCEPTION WHEN no_data_found OR check_violation THEN
        -- Existing catalog contract: incomplete inventory bookkeeping
        -- cannot discard committed patient fulfillment. Record the issue.
        UPDATE resupply.fulfillments SET shipment_metadata =
          shipment_metadata || '{"inventoryReviewRequired":true}'::jsonb
          WHERE org_id = p_org_id AND id = v_fulfillment;
      END;
    END IF;
    v_ids := v_ids || jsonb_build_array(v_fulfillment);
  END LOOP;
  RETURN jsonb_build_object('status', 'queued', 'fulfillmentIds', v_ids, 'replayed', false);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resupply.dispense_csr_priced_order(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION resupply.dispense_csr_priced_order(uuid,uuid) TO service_role;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION resupply.create_csr_priced_order(
  p_org_id uuid, p_quote_id uuid, p_quote_revision integer,
  p_draft_id uuid, p_request jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, resupply
AS $$
DECLARE
  v_quote resupply.pricing_quotes%ROWTYPE;
  v_order resupply.csr_order_requests%ROWTYPE;
  v_draft resupply.resupply_order_drafts%ROWTYPE;
  v_items jsonb;
  v_submitted jsonb;
  v_total bigint;
  v_id uuid := gen_random_uuid();
  v_expires timestamptz;
BEGIN
  PERFORM resupply.pricing_lock_state(p_org_id);
  SELECT * INTO v_quote FROM resupply.pricing_quotes
    WHERE org_id = p_org_id AND id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'quote_not_found' USING ERRCODE = 'P0002'; END IF;
  IF v_quote.revision IS DISTINCT FROM p_quote_revision THEN
    RAISE EXCEPTION 'revision_conflict' USING ERRCODE = '40001';
  END IF;
  IF v_quote.patient_id IS NULL OR v_quote.patient_id IS DISTINCT FROM (p_request->>'patient_id')::uuid
    OR v_quote.scenario->'revenue'->>'mode' IS DISTINCT FROM 'insurance' THEN
    RAISE EXCEPTION 'insurance_patient_quote_required' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM resupply.patients WHERE org_id = p_org_id AND id = v_quote.patient_id) THEN
    RAISE EXCEPTION 'patient_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF jsonb_array_length(v_quote.lines) NOT BETWEEN 1 AND 20 OR
    EXISTS (SELECT 1 FROM jsonb_array_elements(v_quote.lines) l
      WHERE (l->>'quantity')::integer NOT BETWEEN 1 AND 99
        OR (l->>'unitAmountCents')::bigint NOT BETWEEN 0 AND 5000000
        OR length(l->>'description') NOT BETWEEN 1 AND 250) THEN
    RAISE EXCEPTION 'order_line_bounds' USING ERRCODE = '23514';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('lineId',l->>'id','sku',l->>'sku',
    'description',l->>'description','quantity',(l->>'quantity')::integer,
    'unitAmountCents',(l->>'unitAmountCents')::bigint) ORDER BY l->>'id'),
    sum((l->>'quantity')::bigint * (l->>'unitAmountCents')::bigint)
    INTO v_items, v_total FROM jsonb_array_elements(v_quote.lines) l;
  SELECT jsonb_agg(jsonb_build_object('lineId',l->>'lineId','sku',l->>'sku',
    'description',l->>'description','quantity',(l->>'quantity')::integer,
    'unitAmountCents',(l->>'unitAmountCents')::bigint) ORDER BY l->>'lineId')
    INTO v_submitted FROM jsonb_array_elements(p_request->'items') l;
  IF v_items IS DISTINCT FROM v_submitted OR v_total NOT BETWEEN 50 AND 10000000
    OR v_total IS DISTINCT FROM (p_request->>'amount_total_cents')::bigint THEN
    RAISE EXCEPTION 'quote_items_changed' USING ERRCODE = '23514';
  END IF;
  IF p_draft_id IS NOT NULL THEN
    SELECT * INTO v_draft FROM resupply.resupply_order_drafts
      WHERE org_id = p_org_id AND id = p_draft_id FOR UPDATE;
    IF NOT FOUND OR v_draft.patient_id IS DISTINCT FROM v_quote.patient_id THEN
      RAISE EXCEPTION 'draft_patient_mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- A retry returns the original immutable commitment; it never sends a
  -- second invite. Changed recipients/documents are a separate revision.
  IF v_quote.status = 'bound' THEN
    SELECT * INTO v_order FROM resupply.csr_order_requests
      WHERE org_id = p_org_id AND id = v_quote.bound_order_id;
    IF NOT FOUND OR v_order.status NOT IN ('sent','viewed','signed')
      OR v_order.items IS DISTINCT FROM v_items
      OR v_order.customer_name IS DISTINCT FROM p_request->>'customer_name'
      OR v_order.customer_email IS DISTINCT FROM p_request->>'customer_email'
      OR v_order.customer_phone IS DISTINCT FROM p_request->>'customer_phone'
      OR v_order.documents IS DISTINCT FROM p_request->'documents'
      OR v_order.note_to_customer IS DISTINCT FROM p_request->>'note_to_customer'
      OR (p_draft_id IS NOT NULL AND v_draft.csr_order_request_id IS DISTINCT FROM v_order.id) THEN
      RAISE EXCEPTION 'quote_already_bound' USING ERRCODE = '40001';
    END IF;
    RETURN jsonb_build_object('id',v_order.id,'order_reference',v_order.order_reference,
      'link_version',v_order.link_version,'replayed',true);
  END IF;
  v_quote := resupply.pricing_assert_quote_current(p_org_id,p_quote_id,p_quote_revision);
  IF v_quote.status <> 'approved' OR v_quote.approval_class = 'blocked' THEN
    RAISE EXCEPTION 'approved_quote_required' USING ERRCODE = '23514';
  END IF;
  IF p_draft_id IS NOT NULL AND v_draft.status NOT IN ('proposed','approved') THEN
    RAISE EXCEPTION 'draft_not_open' USING ERRCODE = '40001';
  END IF;
  v_expires := least((p_request->>'expires_at')::timestamptz, v_quote.valid_until);
  IF v_expires <= clock_timestamp() THEN RAISE EXCEPTION 'quote_expired' USING ERRCODE = '40001'; END IF;
  INSERT INTO resupply.csr_order_requests(id,org_id,patient_id,pricing_quote_id,order_reference,
    status,customer_name,customer_email,customer_phone,items,amount_total_cents,currency,
    note_to_customer,documents,link_version,expires_at,sent_at,created_by_email)
  VALUES(v_id,p_org_id,v_quote.patient_id,v_quote.id,p_request->>'order_reference','sent',
    p_request->>'customer_name',p_request->>'customer_email',p_request->>'customer_phone',
    v_items,v_total,'usd',p_request->>'note_to_customer',p_request->'documents',1,
    v_expires,clock_timestamp(),p_request->>'created_by_email');
  UPDATE resupply.pricing_quotes SET status='bound',bound_order_id=v_id,updated_at=clock_timestamp()
    WHERE org_id=p_org_id AND id=p_quote_id;
  IF p_draft_id IS NOT NULL THEN
    UPDATE resupply.resupply_order_drafts SET status='ordered',csr_order_request_id=v_id,updated_at=clock_timestamp()
      WHERE org_id=p_org_id AND id=p_draft_id;
  END IF;
  INSERT INTO resupply.pricing_events(org_id,entity_id,operation,actor,data)
    VALUES(p_org_id,p_quote_id,'order.bound',coalesce(p_request->>'created_by_email','staff'),
      jsonb_build_object('orderId',v_id,'quoteRevision',p_quote_revision,'draftId',p_draft_id));
  RETURN jsonb_build_object('id',v_id,'order_reference',p_request->>'order_reference',
    'link_version',1,'replayed',false);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resupply.create_csr_priced_order(uuid,uuid,integer,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION resupply.create_csr_priced_order(uuid,uuid,integer,uuid,jsonb) TO service_role;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resupply.guard_csr_pricing_commit()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, resupply
AS $$
DECLARE v_enforce boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.pricing_quote_id IS NOT NULL AND
    (NEW.items IS DISTINCT FROM OLD.items OR NEW.amount_total_cents IS DISTINCT FROM OLD.amount_total_cents
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.pricing_quote_id IS DISTINCT FROM OLD.pricing_quote_id) THEN
    RAISE EXCEPTION 'approved_order_is_immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM resupply.pricing_lock_state(NEW.org_id);
    SELECT enforce_quotes INTO v_enforce FROM resupply.pricing_state WHERE org_id=NEW.org_id FOR UPDATE;
    IF v_enforce AND NEW.pricing_quote_id IS NULL THEN
      RAISE EXCEPTION 'approved_quote_required' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resupply.guard_csr_pricing_commit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION resupply.guard_csr_pricing_commit() TO service_role;
CREATE TRIGGER csr_pricing_commit_guard BEFORE INSERT OR UPDATE OF items, amount_total_cents, patient_id, pricing_quote_id
  ON resupply.csr_order_requests FOR EACH ROW EXECUTE FUNCTION resupply.guard_csr_pricing_commit();
