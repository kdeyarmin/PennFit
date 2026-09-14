-- Created with `supabase migration new pricing_profitability`; repository ordered naming.
-- No policy or business margin is activated by this migration.
CREATE TABLE resupply.pricing_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES resupply.organizations(id),
  version integer NOT NULL CHECK(version>0), data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
  effective_from timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
  UNIQUE(org_id,id), UNIQUE(org_id,version), CHECK(expires_at>effective_from)
);
CREATE TABLE resupply.pricing_offers (
  id uuid NOT NULL, org_id uuid NOT NULL REFERENCES resupply.organizations(id), version integer NOT NULL CHECK(version>0),
  sku text NOT NULL, is_current boolean NOT NULL DEFAULT true, data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),
  effective_from timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
  PRIMARY KEY(org_id,id,version), CHECK(expires_at>effective_from)
);
CREATE INDEX pricing_offers_sku_idx ON resupply.pricing_offers(org_id,sku,id,version DESC);
CREATE UNIQUE INDEX pricing_offers_current_idx ON resupply.pricing_offers(org_id,id) WHERE is_current;
CREATE TABLE resupply.pricing_price_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES resupply.organizations(id),
  name text NOT NULL, entries jsonb NOT NULL CHECK(jsonb_typeof(entries)='array' AND jsonb_array_length(entries)>0),
  scheduled_at timestamptz, schedule_status text CHECK(schedule_status IN ('pending','applied','cancelled','blocked')), schedule_error text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL, UNIQUE(org_id,id)
);
CREATE UNIQUE INDEX pricing_price_lists_pending_idx ON resupply.pricing_price_lists(org_id) WHERE schedule_status='pending';
CREATE TABLE resupply.pricing_state (
  org_id uuid PRIMARY KEY REFERENCES resupply.organizations(id), revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
  enabled boolean NOT NULL DEFAULT false, enforce_quotes boolean NOT NULL DEFAULT false,
  current_policy_id uuid, active_price_list_id uuid,
  CHECK(NOT enforce_quotes OR enabled),
  FOREIGN KEY(org_id,current_policy_id) REFERENCES resupply.pricing_policies(org_id,id),
  FOREIGN KEY(org_id,active_price_list_id) REFERENCES resupply.pricing_price_lists(org_id,id)
);
CREATE TABLE resupply.pricing_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES resupply.organizations(id),
  patient_id uuid REFERENCES resupply.patients(id), revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  status text NOT NULL CHECK(status IN ('draft','pending_approval','approved','bound')),
  policy_id uuid NOT NULL, policy_version integer NOT NULL,
  scenario jsonb NOT NULL, input jsonb NOT NULL, evaluation jsonb NOT NULL, lines jsonb NOT NULL,
  dependencies jsonb NOT NULL CHECK(jsonb_typeof(dependencies)='array'),
  approval_class text NOT NULL CHECK(approval_class IN ('firm','exception','blocked')),
  valid_until timestamptz NOT NULL, approved_by text, approved_at timestamptz, bound_order_id uuid,
  actuals_revision integer NOT NULL DEFAULT 0, costs_complete boolean NOT NULL DEFAULT false, revenue_complete boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
  UNIQUE(org_id,id), FOREIGN KEY(org_id,policy_id) REFERENCES resupply.pricing_policies(org_id,id),
  CHECK(jsonb_typeof(lines)='array' AND jsonb_array_length(lines)>0)
);
CREATE INDEX pricing_quotes_queue_idx ON resupply.pricing_quotes(org_id,status,created_at DESC,id);
CREATE TABLE resupply.pricing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES resupply.organizations(id),
  entity_id uuid NOT NULL, operation text NOT NULL, actor text NOT NULL, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pricing_events_entity_idx ON resupply.pricing_events(org_id,entity_id,created_at DESC);
CREATE TABLE resupply.pricing_actual_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES resupply.organizations(id), quote_id uuid NOT NULL,
  economic_event_id text NOT NULL, source text NOT NULL, source_ref text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('cost','revenue','refund','cost_credit')), amount_cents bigint NOT NULL CHECK(amount_cents>=0 AND amount_cents<=100000000),
  data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
  FOREIGN KEY(org_id,quote_id) REFERENCES resupply.pricing_quotes(org_id,id),
  UNIQUE(org_id,economic_event_id), UNIQUE(org_id,source,source_ref)
);
CREATE INDEX pricing_actual_events_quote_idx ON resupply.pricing_actual_events(org_id,quote_id,created_at,id);
CREATE TABLE resupply.pricing_shipping_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES resupply.organizations(id),
  cost_cents integer NOT NULL CHECK(cost_cents>=0), data jsonb NOT NULL,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(org_id,id)
);
CREATE TABLE resupply.pricing_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES resupply.organizations(id),
  revision integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewing','resolved','rejected')),
  data jsonb NOT NULL, sku text, review_notes text, created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL,
  UNIQUE(org_id,id)
);
CREATE INDEX pricing_proposals_queue_idx ON resupply.pricing_proposals(org_id,status,created_at DESC,id);
CREATE TABLE resupply.pricing_revenue_profiles (
  id uuid NOT NULL,org_id uuid NOT NULL REFERENCES resupply.organizations(id),version integer NOT NULL CHECK(version>0),
  patient_id uuid NOT NULL REFERENCES resupply.patients(id),data jsonb NOT NULL,
  effective_from timestamptz NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),created_by text NOT NULL,
  PRIMARY KEY(org_id,id,version),CHECK(expires_at>effective_from)
);
CREATE INDEX pricing_revenue_profiles_patient_idx ON resupply.pricing_revenue_profiles(org_id,patient_id,id,version DESC);
CREATE TABLE resupply.pricing_alert_reviews (
  org_id uuid NOT NULL REFERENCES resupply.organizations(id),key text NOT NULL CHECK(key ~ '^[a-f0-9]{32}$'),
  revision integer NOT NULL,status text NOT NULL CHECK(status IN ('open','resolved')),owner text NOT NULL,review_at timestamptz,notes text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(org_id,key)
);
-- Runtime access is service-only. The tenant policy is a backstop for scoped SQL.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pricing_policies','pricing_offers','pricing_price_lists','pricing_state','pricing_quotes','pricing_events','pricing_actual_events','pricing_shipping_quotes','pricing_proposals','pricing_revenue_profiles','pricing_alert_reviews'] LOOP
    EXECUTE format('ALTER TABLE resupply.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY pricing_tenant ON resupply.%I USING (org_id = nullif(current_setting(''app.current_org_id'',true),'''')::uuid) WITH CHECK (org_id = nullif(current_setting(''app.current_org_id'',true),'''')::uuid)',t);
    EXECUTE format('REVOKE ALL ON resupply.%I FROM PUBLIC,anon,authenticated',t);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON resupply.%I TO service_role',t);
  END LOOP;
END; $$;

CREATE FUNCTION resupply.pricing_current_offers(p_org_id uuid,p_ids uuid[] DEFAULT NULL,p_sku text DEFAULT NULL,p_offset integer DEFAULT 0,p_limit integer DEFAULT 101) RETURNS SETOF resupply.pricing_offers
LANGUAGE sql SECURITY INVOKER STABLE SET search_path='' AS $$
 SELECT o.* FROM (SELECT DISTINCT ON(id) * FROM resupply.pricing_offers WHERE org_id=p_org_id AND effective_from<=statement_timestamp() AND (p_ids IS NULL OR id=ANY(p_ids)) AND (p_sku IS NULL OR sku=p_sku) ORDER BY id,version DESC) o ORDER BY o.sku,o.id OFFSET greatest(p_offset,0) LIMIT least(greatest(p_limit,1),101);
$$;
CREATE FUNCTION resupply.pricing_current_revenue_profiles(p_org_id uuid,p_patient_id uuid DEFAULT NULL,p_offset integer DEFAULT 0,p_limit integer DEFAULT 101) RETURNS SETOF resupply.pricing_revenue_profiles
LANGUAGE sql SECURITY INVOKER STABLE SET search_path='' AS $$
 SELECT r.* FROM (SELECT DISTINCT ON(id) * FROM resupply.pricing_revenue_profiles WHERE org_id=p_org_id AND effective_from<=statement_timestamp() AND (p_patient_id IS NULL OR patient_id=p_patient_id) ORDER BY id,version DESC) r ORDER BY r.created_at DESC,r.id OFFSET greatest(p_offset,0) LIMIT least(greatest(p_limit,1),101);
$$;

-- Every writer locks the same per-tenant state row before dependent records.
CREATE FUNCTION resupply.pricing_lock_state(p_org_id uuid) RETURNS resupply.pricing_state
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v resupply.pricing_state%rowtype;
BEGIN
  INSERT INTO resupply.pricing_state(org_id) VALUES(p_org_id) ON CONFLICT DO NOTHING;
  SELECT * INTO STRICT v FROM resupply.pricing_state WHERE org_id=p_org_id FOR UPDATE;
  RETURN v;
END; $$;
CREATE FUNCTION resupply.pricing_assert_dependencies(p_org_id uuid,p_dependencies jsonb) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE d jsonb; o resupply.pricing_offers%rowtype;
BEGIN
  IF jsonb_typeof(p_dependencies) IS DISTINCT FROM 'array' OR jsonb_array_length(p_dependencies)=0 THEN RAISE EXCEPTION 'stale_dependencies' USING ERRCODE='40001'; END IF;
  FOR d IN SELECT * FROM jsonb_array_elements(p_dependencies) LOOP
    SELECT * INTO o FROM resupply.pricing_offers WHERE org_id=p_org_id AND id=(d->>'offerId')::uuid AND effective_from<=clock_timestamp() ORDER BY version DESC LIMIT 1;
    IF NOT FOUND OR o.version IS DISTINCT FROM (d->>'version')::integer OR o.effective_from>clock_timestamp() OR o.expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'stale_dependencies' USING ERRCODE='40001';
    END IF;
  END LOOP;
END; $$;
CREATE FUNCTION resupply.pricing_assert_quote_current(p_org_id uuid,p_quote_id uuid,p_revision integer) RETURNS resupply.pricing_quotes
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE s resupply.pricing_state%rowtype; q resupply.pricing_quotes%rowtype; p resupply.pricing_policies%rowtype;
BEGIN
  s:=resupply.pricing_lock_state(p_org_id);
  SELECT * INTO q FROM resupply.pricing_quotes WHERE org_id=p_org_id AND id=p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
  IF q.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001'; END IF;
  IF q.valid_until<=clock_timestamp() OR NOT s.enabled OR q.policy_id IS DISTINCT FROM s.current_policy_id THEN RAISE EXCEPTION 'stale_dependencies' USING ERRCODE='40001'; END IF;
  SELECT * INTO p FROM resupply.pricing_policies WHERE org_id=p_org_id AND id=q.policy_id;
  IF NOT FOUND OR p.version IS DISTINCT FROM q.policy_version OR p.effective_from>clock_timestamp() OR p.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'stale_dependencies' USING ERRCODE='40001'; END IF;
  PERFORM resupply.pricing_assert_dependencies(p_org_id,q.dependencies);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(q.lines) line WHERE NOT EXISTS(SELECT 1 FROM resupply.products WHERE org_id=p_org_id AND sku=line->>'sku' AND active)) THEN RAISE EXCEPTION 'stale_dependencies' USING ERRCODE='40001'; END IF;
  IF q.patient_id IS NOT NULL AND q.scenario ? 'deliveryAddressSnapshot' AND NOT EXISTS(SELECT 1 FROM resupply.patients WHERE org_id=p_org_id AND id=q.patient_id AND address IS NOT DISTINCT FROM nullif(q.scenario->'deliveryAddressSnapshot','null'::jsonb)) THEN RAISE EXCEPTION 'stale_dependencies' USING ERRCODE='40001'; END IF;
  IF q.scenario->>'revenueProfileId' IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM (SELECT * FROM resupply.pricing_revenue_profiles WHERE org_id=p_org_id AND id=(q.scenario->>'revenueProfileId')::uuid AND effective_from<=clock_timestamp() ORDER BY version DESC LIMIT 1) rp
    WHERE rp.patient_id=q.patient_id AND rp.version=(q.scenario->>'revenueProfileVersion')::integer AND rp.expires_at>clock_timestamp()
  ) THEN RAISE EXCEPTION 'stale_dependencies' USING ERRCODE='40001'; END IF;
  IF q.scenario->>'shippingQuoteId' IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM resupply.pricing_shipping_quotes shipping JOIN resupply.patients patient ON patient.org_id=shipping.org_id AND patient.id=q.patient_id
    WHERE shipping.org_id=p_org_id AND shipping.id=(q.scenario->>'shippingQuoteId')::uuid AND shipping.expires_at>clock_timestamp()
      AND shipping.data->'patientAddressSnapshot' IS NOT DISTINCT FROM patient.address
  ) THEN RAISE EXCEPTION 'stale_dependencies' USING ERRCODE='40001'; END IF;
  RETURN q;
END; $$;

CREATE FUNCTION resupply.pricing_mutate(p_org_id uuid,p_actor text,p_operation text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE s resupply.pricing_state%rowtype; q resupply.pricing_quotes%rowtype; p resupply.pricing_policies%rowtype;
  v_id uuid; v_version integer; v_result jsonb; e jsonb; a resupply.pricing_actual_events%rowtype;
BEGIN
  IF p_actor IS NULL OR length(p_actor)=0 OR p_payload IS NULL THEN RAISE EXCEPTION 'invalid_body' USING ERRCODE='22023'; END IF;
  s:=resupply.pricing_lock_state(p_org_id);
  IF p_operation='revenue_profile' THEN
    v_id:=coalesce((p_payload->>'id')::uuid,gen_random_uuid());
    IF NOT EXISTS(SELECT 1 FROM resupply.patients WHERE org_id=p_org_id AND id=(p_payload->>'patientId')::uuid) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
    SELECT coalesce(max(version),0) INTO v_version FROM resupply.pricing_revenue_profiles WHERE org_id=p_org_id AND id=v_id;
    IF v_version IS DISTINCT FROM coalesce((p_payload->>'expectedVersion')::integer,0) THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001'; END IF;
    IF EXISTS(SELECT 1 FROM resupply.pricing_revenue_profiles WHERE org_id=p_org_id AND id=v_id AND patient_id IS DISTINCT FROM (p_payload->>'patientId')::uuid) THEN RAISE EXCEPTION 'profile_patient_immutable' USING ERRCODE='22023'; END IF;
    INSERT INTO resupply.pricing_revenue_profiles(id,org_id,version,patient_id,data,effective_from,expires_at,created_by)
    VALUES(v_id,p_org_id,v_version+1,(p_payload->>'patientId')::uuid,p_payload-ARRAY['id','expectedVersion'],(p_payload->>'effectiveFrom')::timestamptz,(p_payload->>'expiresAt')::timestamptz,p_actor) RETURNING to_jsonb(pricing_revenue_profiles.*) INTO v_result;
  ELSIF p_operation='alert_review' THEN
    v_id:=p_org_id;
    SELECT revision INTO v_version FROM resupply.pricing_alert_reviews WHERE org_id=p_org_id AND key=p_payload->>'key';
    IF coalesce(v_version,0) IS DISTINCT FROM (p_payload->>'expectedRevision')::integer THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001'; END IF;
    INSERT INTO resupply.pricing_alert_reviews(org_id,key,revision,status,owner,review_at,notes)
    VALUES(p_org_id,p_payload->>'key',coalesce(v_version,0)+1,p_payload->>'status',p_payload->>'owner',(p_payload->>'reviewAt')::timestamptz,p_payload->>'notes')
    ON CONFLICT(org_id,key) DO UPDATE SET revision=excluded.revision,status=excluded.status,owner=excluded.owner,review_at=excluded.review_at,notes=excluded.notes,updated_at=clock_timestamp() RETURNING to_jsonb(pricing_alert_reviews.*) INTO v_result;
  ELSIF p_operation='proposal' THEN
    SELECT id,to_jsonb(pricing_proposals.*) INTO v_id,v_result FROM resupply.pricing_proposals WHERE org_id=p_org_id AND data=p_payload ORDER BY created_at LIMIT 1;
    IF FOUND THEN RETURN v_result; END IF;
    INSERT INTO resupply.pricing_proposals(org_id,data,created_by) VALUES(p_org_id,p_payload,p_actor) RETURNING id,to_jsonb(pricing_proposals.*) INTO v_id,v_result;
  ELSIF p_operation='review_proposal' THEN
    v_id:=(p_payload->>'id')::uuid;
    IF p_payload->>'status'='resolved' AND NOT EXISTS(SELECT 1 FROM resupply.products WHERE org_id=p_org_id AND sku=p_payload->>'sku') THEN RAISE EXCEPTION 'invalid_sku' USING ERRCODE='22023'; END IF;
    UPDATE resupply.pricing_proposals SET revision=revision+1,status=p_payload->>'status',sku=p_payload->>'sku',review_notes=p_payload->>'notes' WHERE org_id=p_org_id AND id=v_id AND revision=(p_payload->>'expectedRevision')::integer RETURNING to_jsonb(pricing_proposals.*) INTO v_result;
    IF v_result IS NULL THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001'; END IF;
  ELSIF p_operation='offer' THEN
    IF p_payload->>'id' IS NULL THEN
      SELECT id,to_jsonb(pricing_offers.*) INTO v_id,v_result FROM resupply.pricing_offers WHERE org_id=p_org_id AND is_current
        AND (data=p_payload-ARRAY['id','expectedVersion'] OR (effective_from<=clock_timestamp() AND (p_payload->>'effectiveFrom')::timestamptz<=clock_timestamp() AND data-'effectiveFrom'=p_payload-ARRAY['id','expectedVersion','effectiveFrom'])) ORDER BY created_at LIMIT 1;
      IF FOUND THEN RETURN v_result; END IF;
    END IF;
    v_id:=coalesce((p_payload->>'id')::uuid,gen_random_uuid());
    SELECT coalesce(max(version),0) INTO v_version FROM resupply.pricing_offers WHERE org_id=p_org_id AND id=v_id;
    IF v_version IS DISTINCT FROM coalesce((p_payload->>'expectedVersion')::integer,0) THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001'; END IF;
    IF EXISTS(SELECT 1 FROM resupply.pricing_offers WHERE org_id=p_org_id AND id=v_id AND sku IS DISTINCT FROM p_payload->>'sku') THEN RAISE EXCEPTION 'offer_sku_immutable' USING ERRCODE='22023'; END IF;
    UPDATE resupply.pricing_offers SET is_current=false WHERE org_id=p_org_id AND id=v_id AND is_current;
    INSERT INTO resupply.pricing_offers(id,org_id,version,sku,data,effective_from,expires_at,created_by)
    VALUES(v_id,p_org_id,v_version+1,p_payload->>'sku',p_payload-ARRAY['id','expectedVersion'],(p_payload->>'effectiveFrom')::timestamptz,(p_payload->>'expiresAt')::timestamptz,p_actor)
    RETURNING to_jsonb(pricing_offers.*) INTO v_result;
  ELSIF p_operation='policy' THEN
    SELECT coalesce(max(version),0)+1 INTO v_version FROM resupply.pricing_policies WHERE org_id=p_org_id;
    INSERT INTO resupply.pricing_policies(org_id,version,data,effective_from,expires_at,created_by)
    VALUES(p_org_id,v_version,p_payload,(p_payload->>'effectiveFrom')::timestamptz,(p_payload->>'expiresAt')::timestamptz,p_actor)
    RETURNING id,to_jsonb(pricing_policies.*) INTO v_id,v_result;
  ELSIF p_operation='publish' THEN
    IF s.revision IS DISTINCT FROM (p_payload->>'expectedStateRevision')::integer THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001'; END IF;
    v_id:=(p_payload->>'id')::uuid;
    SELECT * INTO p FROM resupply.pricing_policies WHERE org_id=p_org_id AND id=v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
    IF (p_payload->>'enabled')::boolean AND (p.effective_from>clock_timestamp() OR p.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'stale_dependencies' USING ERRCODE='40001'; END IF;
    UPDATE resupply.pricing_state SET revision=revision+1,current_policy_id=v_id,enabled=(p_payload->>'enabled')::boolean,enforce_quotes=(p_payload->>'enforceQuotes')::boolean,active_price_list_id=null WHERE org_id=p_org_id;
    SELECT to_jsonb(pricing_state.*) INTO v_result FROM resupply.pricing_state WHERE org_id=p_org_id;
  ELSIF p_operation='quote' THEN
    v_id:=coalesce((p_payload->>'id')::uuid,gen_random_uuid());
    SELECT * INTO q FROM resupply.pricing_quotes WHERE org_id=p_org_id AND id=v_id FOR UPDATE;
    IF FOUND THEN
      IF q.revision IS DISTINCT FROM (p_payload->>'expectedRevision')::integer OR q.status='bound' THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001'; END IF;
      v_version:=q.revision+1;
    ELSE
      IF p_payload->>'expectedRevision' IS NOT NULL THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001'; END IF;
      v_version:=1;
    END IF;
    IF p_payload->>'patientId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM resupply.patients WHERE org_id=p_org_id AND id=(p_payload->>'patientId')::uuid) THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
    PERFORM resupply.pricing_assert_dependencies(p_org_id,p_payload->'dependencies');
    IF p_payload->'scenario' ? 'activePriceListId' AND (p_payload->'scenario'->>'activePriceListId')::uuid IS DISTINCT FROM s.active_price_list_id THEN RAISE EXCEPTION 'stale_dependencies' USING ERRCODE='40001'; END IF;
    SELECT * INTO p FROM resupply.pricing_policies WHERE org_id=p_org_id AND id=(p_payload->>'policyId')::uuid;
    IF NOT FOUND OR p.version IS DISTINCT FROM (p_payload->>'policyVersion')::integer THEN RAISE EXCEPTION 'stale_dependencies' USING ERRCODE='40001'; END IF;
    INSERT INTO resupply.pricing_quotes(id,org_id,patient_id,revision,status,policy_id,policy_version,scenario,input,evaluation,lines,dependencies,approval_class,valid_until,created_by)
    VALUES(v_id,p_org_id,(p_payload->>'patientId')::uuid,v_version,p_payload->>'status',p.id,p.version,p_payload->'scenario',p_payload->'input',p_payload->'evaluation',p_payload->'lines',p_payload->'dependencies',p_payload->>'approvalClass',(p_payload->>'validUntil')::timestamptz,p_actor)
    ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,status=excluded.status,patient_id=excluded.patient_id,policy_id=excluded.policy_id,policy_version=excluded.policy_version,scenario=excluded.scenario,input=excluded.input,evaluation=excluded.evaluation,lines=excluded.lines,dependencies=excluded.dependencies,approval_class=excluded.approval_class,valid_until=excluded.valid_until,approved_by=null,approved_at=null,updated_at=clock_timestamp()
      WHERE pricing_quotes.org_id=p_org_id AND pricing_quotes.status<>'bound'
    RETURNING to_jsonb(pricing_quotes.*) INTO v_result;
    IF v_result IS NULL THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001'; END IF;
    IF (p_payload->>'autoApprove')::boolean AND p_payload->>'approvalClass'='firm' AND s.enabled THEN
      q:=resupply.pricing_assert_quote_current(p_org_id,v_id,v_version);
      UPDATE resupply.pricing_quotes SET status='approved',approved_by=p_actor,approved_at=clock_timestamp() WHERE org_id=p_org_id AND id=v_id RETURNING to_jsonb(pricing_quotes.*) INTO v_result;
    END IF;
  ELSIF p_operation='approve' THEN
    v_id:=(p_payload->>'id')::uuid;
    q:=resupply.pricing_assert_quote_current(p_org_id,v_id,(p_payload->>'expectedRevision')::integer);
    IF q.status NOT IN ('draft','pending_approval') THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001'; END IF;
    IF q.approval_class='blocked' OR (q.approval_class='exception' AND (p_payload->>'allowException')::boolean IS DISTINCT FROM true) THEN RAISE EXCEPTION 'blocked_pricing' USING ERRCODE='22023'; END IF;
    IF length(btrim(p_payload->>'reason'))<10 THEN RAISE EXCEPTION 'invalid_body' USING ERRCODE='22023'; END IF;
    UPDATE resupply.pricing_quotes SET status='approved',approved_by=p_actor,approved_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE org_id=p_org_id AND id=v_id RETURNING to_jsonb(pricing_quotes.*) INTO v_result;
  ELSIF p_operation='batch' THEN
    FOR e IN SELECT * FROM jsonb_array_elements(p_payload->'entries') LOOP
      PERFORM resupply.pricing_assert_dependencies(p_org_id,e->'dependencies');
    END LOOP;
    INSERT INTO resupply.pricing_price_lists(org_id,name,entries,created_by) VALUES(p_org_id,p_payload->>'name',p_payload->'entries',p_actor) RETURNING id,to_jsonb(pricing_price_lists.*) INTO v_id,v_result;
  ELSIF p_operation='activate' THEN
    IF s.revision IS DISTINCT FROM (p_payload->>'expectedStateRevision')::integer OR NOT s.enabled THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001'; END IF;
    v_id:=(p_payload->>'id')::uuid;
    SELECT entries INTO v_result FROM resupply.pricing_price_lists WHERE org_id=p_org_id AND id=v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
    FOR e IN SELECT * FROM jsonb_array_elements(v_result) LOOP
      IF (e->>'policyId')::uuid IS DISTINCT FROM s.current_policy_id OR e->>'approvalClass' IS DISTINCT FROM 'firm' OR (e->'scenario'->>'validUntil')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'blocked_pricing' USING ERRCODE='22023'; END IF;
      SELECT * INTO p FROM resupply.pricing_policies WHERE org_id=p_org_id AND id=s.current_policy_id;
      IF NOT FOUND OR p.expires_at<=clock_timestamp() OR p.effective_from>clock_timestamp() THEN RAISE EXCEPTION 'stale_dependencies' USING ERRCODE='40001'; END IF;
      PERFORM resupply.pricing_assert_dependencies(p_org_id,e->'dependencies');
    END LOOP;
    UPDATE resupply.pricing_state SET revision=revision+1,active_price_list_id=v_id WHERE org_id=p_org_id RETURNING to_jsonb(pricing_state.*) INTO v_result;
  ELSIF p_operation IN ('schedule','cancel_schedule') THEN
    IF s.revision IS DISTINCT FROM (p_payload->>'expectedStateRevision')::integer THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001'; END IF;
    v_id:=(p_payload->>'id')::uuid;
    IF p_operation='schedule' THEN
      IF (p_payload->>'scheduledAt')::timestamptz<=clock_timestamp() OR (p_payload->>'scheduledAt')::timestamptz>clock_timestamp()+interval '30 days' THEN RAISE EXCEPTION 'invalid_schedule' USING ERRCODE='22023'; END IF;
      IF EXISTS(SELECT 1 FROM resupply.pricing_price_lists WHERE org_id=p_org_id AND schedule_status='pending' AND id<>v_id) THEN RAISE EXCEPTION 'schedule_exists' USING ERRCODE='40001'; END IF;
      SELECT entries INTO v_result FROM resupply.pricing_price_lists WHERE org_id=p_org_id AND id=v_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
      FOR e IN SELECT * FROM jsonb_array_elements(v_result) LOOP
        IF e->>'approvalClass' IS DISTINCT FROM 'firm' OR (e->>'policyId')::uuid IS DISTINCT FROM s.current_policy_id OR (e->'scenario'->>'validUntil')::timestamptz<=(p_payload->>'scheduledAt')::timestamptz THEN RAISE EXCEPTION 'blocked_pricing' USING ERRCODE='22023'; END IF;
      END LOOP;
      UPDATE resupply.pricing_price_lists SET scheduled_at=(p_payload->>'scheduledAt')::timestamptz,schedule_status='pending',schedule_error=null WHERE org_id=p_org_id AND id=v_id;
    ELSE
      UPDATE resupply.pricing_price_lists SET schedule_status='cancelled' WHERE org_id=p_org_id AND id=v_id AND schedule_status='pending';
      IF NOT FOUND THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001'; END IF;
    END IF;
    UPDATE resupply.pricing_state SET revision=revision+1 WHERE org_id=p_org_id;
    SELECT to_jsonb(pricing_price_lists.*) INTO v_result FROM resupply.pricing_price_lists WHERE org_id=p_org_id AND id=v_id;
  ELSIF p_operation='actual' THEN
    v_id:=(p_payload->>'quoteId')::uuid;
    SELECT * INTO q FROM resupply.pricing_quotes WHERE org_id=p_org_id AND id=v_id FOR UPDATE;
    IF NOT FOUND OR q.status<>'bound' THEN RAISE EXCEPTION 'order_required' USING ERRCODE='22023'; END IF;
    SELECT * INTO a FROM resupply.pricing_actual_events WHERE org_id=p_org_id AND (economic_event_id=p_payload->>'economicEventId' OR (source=p_payload->>'source' AND source_ref=p_payload->>'sourceRef')) LIMIT 1;
    IF FOUND THEN
      IF a.quote_id IS DISTINCT FROM v_id OR a.data IS DISTINCT FROM p_payload-'quoteId' THEN RAISE EXCEPTION 'duplicate_economic_event' USING ERRCODE='40001'; END IF;
      RETURN to_jsonb(a);
    END IF;
    IF p_payload->>'lineId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.lines) l WHERE l->>'id'=p_payload->>'lineId') THEN RAISE EXCEPTION 'invalid_line' USING ERRCODE='22023'; END IF;
    INSERT INTO resupply.pricing_actual_events(org_id,quote_id,economic_event_id,source,source_ref,kind,amount_cents,data,created_by)
    VALUES(p_org_id,v_id,p_payload->>'economicEventId',p_payload->>'source',p_payload->>'sourceRef',p_payload->>'kind',(p_payload->>'amountCents')::bigint,p_payload-'quoteId',p_actor) RETURNING to_jsonb(pricing_actual_events.*) INTO v_result;
    UPDATE resupply.pricing_quotes SET actuals_revision=actuals_revision+1,costs_complete=false,revenue_complete=false WHERE org_id=p_org_id AND id=v_id;
  ELSIF p_operation='close_actuals' THEN
    v_id:=(p_payload->>'id')::uuid;
    UPDATE resupply.pricing_quotes SET actuals_revision=actuals_revision+1,costs_complete=(p_payload->>'costsComplete')::boolean,revenue_complete=(p_payload->>'revenueComplete')::boolean
    WHERE org_id=p_org_id AND id=v_id AND status='bound' AND actuals_revision=(p_payload->>'expectedRevision')::integer RETURNING to_jsonb(pricing_quotes.*) INTO v_result;
    IF v_result IS NULL THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001'; END IF;
  ELSE RAISE EXCEPTION 'invalid_operation' USING ERRCODE='22023';
  END IF;
  INSERT INTO resupply.pricing_events(org_id,entity_id,operation,actor,data) VALUES(p_org_id,v_id,p_operation,p_actor,jsonb_build_object('request',p_payload,'result',v_result));
  RETURN v_result;
END; $$;
REVOKE ALL ON FUNCTION resupply.pricing_lock_state(uuid),resupply.pricing_assert_dependencies(uuid,jsonb),resupply.pricing_assert_quote_current(uuid,uuid,integer),resupply.pricing_mutate(uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION resupply.pricing_lock_state(uuid),resupply.pricing_assert_dependencies(uuid,jsonb),resupply.pricing_assert_quote_current(uuid,uuid,integer),resupply.pricing_mutate(uuid,text,text,jsonb) TO service_role;

CREATE FUNCTION resupply.pricing_apply_scheduled(p_org_id uuid) RETURNS jsonb
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
    UPDATE resupply.pricing_price_lists SET schedule_status='blocked',schedule_error=CASE WHEN SQLSTATE='40001' THEN 'stale_dependencies' ELSE 'blocked_pricing' END WHERE org_id=p_org_id AND id=b.id;
    INSERT INTO resupply.pricing_events(org_id,entity_id,operation,actor,data) VALUES(p_org_id,b.id,'schedule_blocked',b.created_by,jsonb_build_object('code',SQLSTATE));
    RETURN jsonb_build_object('status','blocked');
  END;
  RETURN result;
END; $$;
CREATE FUNCTION resupply.pricing_actuals_snapshot(p_org_id uuid,p_quote_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE q resupply.pricing_quotes%rowtype;events jsonb;
BEGIN
  PERFORM resupply.pricing_lock_state(p_org_id);
  SELECT * INTO q FROM resupply.pricing_quotes WHERE org_id=p_org_id AND id=p_quote_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.created_at,e.id),'[]') INTO events FROM (SELECT * FROM resupply.pricing_actual_events WHERE org_id=p_org_id AND quote_id=p_quote_id ORDER BY created_at,id LIMIT 1001) e;
  RETURN jsonb_build_object('quote',to_jsonb(q),'events',events);
END; $$;
CREATE FUNCTION resupply.pricing_alerts(p_org_id uuid,p_offset integer DEFAULT 0,p_limit integer DEFAULT 101) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER STABLE SET search_path='' AS $$
WITH actuals AS (
 SELECT quote_id,sum(CASE kind WHEN 'cost' THEN amount_cents WHEN 'cost_credit' THEN -amount_cents ELSE 0 END) cost,sum(CASE kind WHEN 'revenue' THEN amount_cents WHEN 'refund' THEN -amount_cents ELSE 0 END) revenue
 FROM resupply.pricing_actual_events WHERE org_id=p_org_id GROUP BY quote_id
), signals AS (
 SELECT 'offer_expired' code,o.id entity_id,NULL::bigint amount,o.created_at,o.version::text discriminator FROM resupply.pricing_offers o WHERE o.org_id=p_org_id AND o.is_current AND o.expires_at<=statement_timestamp()
 UNION ALL SELECT 'supplier_cost_increase',o.id,((o.data->>'unitCostCents')::bigint-(prior.data->>'unitCostCents')::bigint),o.created_at,o.version::text FROM resupply.pricing_offers o JOIN resupply.pricing_offers prior ON prior.org_id=o.org_id AND prior.id=o.id AND prior.version=o.version-1 WHERE o.org_id=p_org_id AND o.is_current AND (o.data->>'unitCostCents')::bigint>(prior.data->>'unitCostCents')::bigint
 UNION ALL SELECT 'quote_'||q.approval_class,q.id,NULL::bigint,q.updated_at,q.revision::text FROM resupply.pricing_quotes q WHERE q.org_id=p_org_id AND q.status='pending_approval'
 UNION ALL SELECT 'actual_cost_overrun',q.id,a.cost-(q.evaluation->>'totalVariableCostCents')::bigint,q.updated_at,q.actuals_revision::text FROM resupply.pricing_quotes q JOIN actuals a ON a.quote_id=q.id WHERE q.org_id=p_org_id AND a.cost>(q.evaluation->>'totalVariableCostCents')::bigint
 UNION ALL SELECT 'collection_shortfall',q.id,(q.evaluation->>'netRevenueCents')::bigint-a.revenue,q.updated_at,q.actuals_revision::text FROM resupply.pricing_quotes q JOIN actuals a ON a.quote_id=q.id WHERE q.org_id=p_org_id AND q.revenue_complete AND a.revenue<(q.evaluation->>'netRevenueCents')::bigint
 UNION ALL SELECT 'scheduled_activation_blocked',b.id,NULL::bigint,b.created_at,coalesce(b.scheduled_at::text,'') FROM resupply.pricing_price_lists b WHERE b.org_id=p_org_id AND b.schedule_status='blocked'
), keyed AS (SELECT *,md5(code||':'||entity_id::text||':'||discriminator) key FROM signals), paged AS (
 SELECT jsonb_build_object('key',k.key,'code',k.code,'entityId',k.entity_id,'amountCents',k.amount,'createdAt',k.created_at,'revision',coalesce(r.revision,0),'status',coalesce(r.status,'open'),'owner',coalesce(r.owner,''),'reviewAt',r.review_at,'notes',coalesce(r.notes,'')) item
 FROM keyed k LEFT JOIN resupply.pricing_alert_reviews r ON r.org_id=p_org_id AND r.key=k.key ORDER BY k.created_at DESC,k.key OFFSET greatest(p_offset,0) LIMIT least(greatest(p_limit,1),101)
) SELECT coalesce(jsonb_agg(item),'[]'::jsonb) FROM paged;
$$;
CREATE FUNCTION resupply.pricing_summary(p_org_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER STABLE SET search_path='' AS $$
WITH actuals AS (
 SELECT quote_id,sum(CASE kind WHEN 'revenue' THEN amount_cents WHEN 'refund' THEN -amount_cents ELSE 0 END) revenue,sum(CASE kind WHEN 'cost' THEN amount_cents WHEN 'cost_credit' THEN -amount_cents ELSE 0 END) cost FROM resupply.pricing_actual_events WHERE org_id=p_org_id GROUP BY quote_id
), grouped AS (
 SELECT CASE WHEN q.costs_complete AND q.revenue_complete THEN 'settled' ELSE 'incomplete' END status,count(*) n,
   coalesce(sum(a.revenue),0) revenue,coalesce(sum(a.cost),0) cost,
   coalesce(sum((q.evaluation->>'netRevenueCents')::bigint),0) quoted_revenue,coalesce(sum((q.evaluation->>'totalVariableCostCents')::bigint),0) quoted_cost,
   count(*) FILTER(WHERE q.evaluation->>'netRevenueCents' IS NULL OR q.evaluation->>'totalVariableCostCents' IS NULL) incomplete_quoted
 FROM resupply.pricing_quotes q LEFT JOIN actuals a ON a.quote_id=q.id WHERE q.org_id=p_org_id AND q.status='bound' GROUP BY 1
) SELECT jsonb_build_object('groups',coalesce(jsonb_agg(jsonb_build_object('status',status,'quoteCount',n,'revenueCents',revenue,'costCents',cost,'contributionCents',revenue-cost,'marginBps',CASE WHEN revenue>0 THEN (revenue-cost)*10000.0/revenue ELSE null END,'quotedRevenueCents',quoted_revenue,'quotedCostCents',quoted_cost,'incompleteQuotedCount',incomplete_quoted)),'[]')) FROM grouped;
$$;
REVOKE ALL ON FUNCTION resupply.pricing_current_offers(uuid,uuid[],text,integer,integer),resupply.pricing_current_revenue_profiles(uuid,uuid,integer,integer),resupply.pricing_apply_scheduled(uuid),resupply.pricing_actuals_snapshot(uuid,uuid),resupply.pricing_alerts(uuid,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION resupply.pricing_current_offers(uuid,uuid[],text,integer,integer),resupply.pricing_current_revenue_profiles(uuid,uuid,integer,integer),resupply.pricing_apply_scheduled(uuid),resupply.pricing_actuals_snapshot(uuid,uuid),resupply.pricing_alerts(uuid,integer,integer) TO service_role;
REVOKE ALL ON FUNCTION resupply.pricing_summary(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION resupply.pricing_summary(uuid) TO service_role;
