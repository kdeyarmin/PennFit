-- One native status writer serves the existing platform routes and reviewed Hub
-- commands. The private receipt is operational evidence, not the retired audit log.
CREATE SCHEMA IF NOT EXISTS resupply_private;
REVOKE ALL ON SCHEMA resupply_private FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS resupply_private.tenant_lifecycle_intents (
  command_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL UNIQUE,
  hub_user_id uuid NOT NULL, native_user_id text NOT NULL,
  session_id uuid NOT NULL, target_id uuid NOT NULL REFERENCES resupply.organizations(id),
  before_target jsonb NOT NULL, suspended boolean NOT NULL, reason text NOT NULL,
  preview_digest text NOT NULL CHECK(preview_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  result jsonb,
  CHECK(expires_at > created_at AND expires_at <= created_at + interval '5 minutes'),
  CHECK(length(reason) BETWEEN 10 AND 500 AND reason=btrim(reason)),
  CHECK(octet_length(before_target::text)<=16384)
);
CREATE INDEX IF NOT EXISTS tenant_lifecycle_actor_idx ON resupply_private.tenant_lifecycle_intents(hub_user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS tenant_lifecycle_target_idx ON resupply_private.tenant_lifecycle_intents(target_id);
CREATE INDEX IF NOT EXISTS tenant_lifecycle_native_actor_idx ON resupply_private.tenant_lifecycle_intents(native_user_id);
ALTER TABLE resupply_private.tenant_lifecycle_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON resupply_private.tenant_lifecycle_intents FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION resupply_private.tenant_lifecycle_native_actor(p_user_id text,p_strict boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_user resupply_auth.users%rowtype;
BEGIN
  SELECT * INTO v_user FROM resupply_auth.users WHERE id=p_user_id FOR SHARE;
  IF NOT FOUND OR v_user.status IN ('locked','revoked') OR
    (p_strict AND (v_user.role IS DISTINCT FROM 'admin' OR v_user.status IS DISTINCT FROM 'active' OR v_user.email_verified_at IS NULL)) THEN
    RAISE EXCEPTION 'Current native platform administrator required.' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM resupply.platform_admins WHERE auth_user_id=p_user_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Current native platform administrator required.' USING ERRCODE='42501'; END IF;
END; $$;

CREATE OR REPLACE FUNCTION resupply_private.tenant_lifecycle_actor(p_actor jsonb,p_operation jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_started timestamptz;v_expires timestamptz;v_native text;
BEGIN
  IF p_actor IS NULL OR jsonb_typeof(p_actor)<>'object'
    OR NOT(p_actor ?& ARRAY['user_id','role','method','session_id','session_started_at','assurance_expires_at','operation','native_user_id'])
    OR p_actor-ARRAY['user_id','role','method','session_id','session_started_at','assurance_expires_at','operation','native_user_id']<>'{}'::jsonb
    OR jsonb_typeof(p_actor->'user_id') IS DISTINCT FROM 'string' OR jsonb_typeof(p_actor->'session_id') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_actor->'native_user_id') IS DISTINCT FROM 'string' OR jsonb_typeof(p_actor->'session_started_at') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_actor->'assurance_expires_at') IS DISTINCT FROM 'string'
    OR p_actor->>'role' IS DISTINCT FROM 'platform_admin' OR p_actor->>'method' IS DISTINCT FROM 'sms' OR p_actor->'operation' IS DISTINCT FROM p_operation
    OR coalesce(p_actor->>'native_user_id','') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    OR (p_actor->>'user_id')::uuid IS NULL OR (p_actor->>'session_id')::uuid IS NULL THEN
    RAISE EXCEPTION 'Exact current Hub authorization required.' USING ERRCODE='42501';
  END IF;
  v_started:=(p_actor->>'session_started_at')::timestamptz;v_expires:=(p_actor->>'assurance_expires_at')::timestamptz;
  IF v_started IS NULL OR v_expires IS NULL OR NOT isfinite(v_started) OR NOT isfinite(v_expires)
    OR v_started>clock_timestamp()+interval '5 minutes' OR v_expires<=clock_timestamp() OR v_expires<=v_started
    OR v_expires>v_started+interval '8 hours' THEN
    RAISE EXCEPTION 'Current Hub session expired.' USING ERRCODE='28000';
  END IF;
  v_native:=p_actor->>'native_user_id';PERFORM resupply_private.tenant_lifecycle_native_actor(v_native,true);RETURN v_native;
END; $$;

CREATE OR REPLACE FUNCTION resupply_private.tenant_lifecycle_target(p_row resupply.organizations)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_seed uuid;
BEGIN
  SELECT id INTO v_seed FROM resupply.organizations WHERE slug='penn-home-medical';
  IF v_seed IS NULL THEN RAISE EXCEPTION 'Native tenant directory unavailable.' USING ERRCODE='55000';END IF;
  RETURN jsonb_build_object('id',p_row.id,'slug',p_row.slug,'name',p_row.name,'status',p_row.status,'updatedAt',p_row.updated_at,
    'seedProtected',p_row.id=v_seed OR p_row.slug='penn-home-medical',
    'revision',encode(sha256(convert_to(to_jsonb(p_row)::text,'UTF8')),'hex'));
END; $$;

CREATE OR REPLACE FUNCTION resupply_private.write_tenant_lifecycle_status(p_user_id text,p_target_id uuid,p_status text,p_expected_revision text,p_assurance_expires_at timestamptz)
RETURNS resupply.organizations LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_row resupply.organizations%rowtype;v_target jsonb;
BEGIN
  PERFORM resupply_private.tenant_lifecycle_native_actor(p_user_id,false);
  IF p_status NOT IN ('active','suspended') OR p_status IS NULL THEN RAISE EXCEPTION 'Unsupported tenant state.' USING ERRCODE='22023';END IF;
  SELECT * INTO v_row FROM resupply.organizations WHERE id=p_target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tenant not found.' USING ERRCODE='P0002';END IF;
  v_target:=resupply_private.tenant_lifecycle_target(v_row);
  IF p_status='suspended' AND (v_target->>'seedProtected')::boolean THEN RAISE EXCEPTION 'Cannot suspend the seed tenant.' USING ERRCODE='22023';END IF;
  IF p_expected_revision IS NOT NULL AND v_target->>'revision' IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'Tenant changed after review.' USING ERRCODE='40001';END IF;
  PERFORM resupply_private.tenant_lifecycle_native_actor(p_user_id,false);
  IF p_assurance_expires_at IS NOT NULL AND p_assurance_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Current Hub session expired.' USING ERRCODE='28000';END IF;
  UPDATE resupply.organizations SET status=p_status,updated_at=clock_timestamp() WHERE id=p_target_id RETURNING * INTO v_row;
  RETURN v_row;
END; $$;

CREATE OR REPLACE FUNCTION resupply.set_tenant_lifecycle_status(p_native_user_id text,p_target_id uuid,p_next_status text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE v_row resupply.organizations%rowtype;
BEGIN
  -- The existing cookie/CSRF platform routes keep their existing transitions.
  -- The shared native writer rechecks current platform membership atomically.
  v_row:=resupply_private.write_tenant_lifecycle_status(p_native_user_id,p_target_id,p_next_status,null,null);
  RETURN jsonb_build_object('id',v_row.id,'slug',v_row.slug,'name',v_row.name,'storefront_name',v_row.storefront_name,'status',v_row.status,
    'custom_domain',v_row.custom_domain,'custom_domain_status',v_row.custom_domain_status,'created_at',v_row.created_at);
END; $$;

REVOKE ALL ON FUNCTION resupply_private.tenant_lifecycle_native_actor(text,boolean),resupply_private.tenant_lifecycle_actor(jsonb,jsonb),
  resupply_private.tenant_lifecycle_target(resupply.organizations),resupply_private.write_tenant_lifecycle_status(text,uuid,text,text,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION resupply.set_tenant_lifecycle_status(text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION resupply.set_tenant_lifecycle_status(text,uuid,text) TO service_role;


CREATE OR REPLACE FUNCTION resupply_private.tenant_lifecycle_view(p_intent resupply_private.tenant_lifecycle_intents,p_actor jsonb)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT jsonb_build_object('commandId',p_intent.command_id,'requestId',p_intent.request_id,'action','organizations.setSuspension',
    'targetId',p_intent.target_id,'parameters',jsonb_build_object('suspended',p_intent.suspended),'reason',p_intent.reason,
    'createdAt',p_intent.created_at,'expiresAt',p_intent.expires_at,'previewDigest',p_intent.preview_digest,
    'before',p_intent.before_target,'after',jsonb_build_object('status',CASE WHEN p_intent.suspended THEN 'suspended' ELSE 'active' END),
    'canApplyThisSession',p_intent.result IS NULL AND p_intent.expires_at>clock_timestamp()
      AND p_intent.hub_user_id=(p_actor->>'user_id')::uuid AND p_intent.native_user_id=p_actor->>'native_user_id'
      AND p_intent.session_id=(p_actor->>'session_id')::uuid AND (p_actor->>'assurance_expires_at')::timestamptz>clock_timestamp()
      AND EXISTS(SELECT 1 FROM resupply.organizations o WHERE o.id=p_intent.target_id
        AND encode(sha256(convert_to(to_jsonb(o)::text,'UTF8')),'hex')=p_intent.before_target->>'revision'),
    'result',p_intent.result);
$$;

CREATE OR REPLACE FUNCTION resupply.tenant_lifecycle_command(p_actor jsonb,p_operation jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' AS $$
DECLARE v_native text;v_op text;v_hub uuid;v_session uuid;v_target_id uuid;v_request_id uuid;v_command_id uuid;
  v_row resupply.organizations%rowtype;v_target jsonb;v_intent resupply_private.tenant_lifecycle_intents%rowtype;
  v_suspended boolean;v_next text;v_created timestamptz;v_expires timestamptz;v_digest text;v_result jsonb;v_requests jsonb;v_reason text;
BEGIN
  IF p_operation IS NULL OR jsonb_typeof(p_operation)<>'object' OR octet_length(p_operation::text)>16384
    OR p_operation->>'domain' IS DISTINCT FROM 'tenant.lifecycle.v1'
    OR p_operation->>'operation' NOT IN ('context','preview','apply','resume') OR p_operation->>'operation' IS NULL THEN
    RAISE EXCEPTION 'Unsupported tenant lifecycle operation.' USING ERRCODE='22023';END IF;
  v_native:=resupply_private.tenant_lifecycle_actor(p_actor,p_operation);v_hub:=(p_actor->>'user_id')::uuid;v_session:=(p_actor->>'session_id')::uuid;
  v_op:=p_operation->>'operation';
  IF v_op='context' THEN
    IF NOT(p_operation ?& ARRAY['domain','operation','targetId']) OR p_operation-ARRAY['domain','operation','targetId']<>'{}'::jsonb THEN
      RAISE EXCEPTION 'Invalid tenant context.' USING ERRCODE='22023';END IF;
    v_target_id:=(p_operation->>'targetId')::uuid;
    SELECT * INTO v_row FROM resupply.organizations WHERE id=v_target_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tenant not found.' USING ERRCODE='P0002';END IF;
    v_target:=resupply_private.tenant_lifecycle_target(v_row);
    SELECT coalesce(jsonb_agg(resupply_private.tenant_lifecycle_view(i.intent,p_actor) ORDER BY (i.intent).created_at DESC,(i.intent).command_id),'[]'::jsonb)
      INTO v_requests FROM (SELECT t AS intent FROM resupply_private.tenant_lifecycle_intents t WHERE target_id=v_target_id AND hub_user_id=v_hub
        ORDER BY created_at DESC,command_id LIMIT 20) i;
    PERFORM resupply_private.tenant_lifecycle_actor(p_actor,p_operation);
    RETURN jsonb_build_object('target',v_target,'requests',v_requests);
  ELSIF v_op='resume' THEN
    IF NOT(p_operation ?& ARRAY['domain','operation','requestId']) OR p_operation-ARRAY['domain','operation','requestId']<>'{}'::jsonb THEN
      RAISE EXCEPTION 'Invalid tenant recovery.' USING ERRCODE='22023';END IF;
    SELECT * INTO v_intent FROM resupply_private.tenant_lifecycle_intents WHERE request_id=(p_operation->>'requestId')::uuid;
    IF NOT FOUND OR v_intent.hub_user_id IS DISTINCT FROM v_hub THEN RAISE EXCEPTION 'Saved request owner required.' USING ERRCODE='42501';END IF;
    PERFORM resupply_private.tenant_lifecycle_actor(p_actor,p_operation);
    RETURN resupply_private.tenant_lifecycle_view(v_intent,p_actor);
  ELSIF v_op='preview' THEN
    IF NOT(p_operation ?& ARRAY['domain','operation','requestId','targetId','action','parameters','expectedRevision','reason'])
      OR p_operation-ARRAY['domain','operation','requestId','targetId','action','parameters','expectedRevision','reason']<>'{}'::jsonb
      OR p_operation->>'action' IS DISTINCT FROM 'organizations.setSuspension'
      OR jsonb_typeof(p_operation->'parameters') IS DISTINCT FROM 'object'
      OR (p_operation->'parameters')-ARRAY['suspended']<>'{}'::jsonb
      OR jsonb_typeof(p_operation->'parameters'->'suspended') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(p_operation->'reason') IS DISTINCT FROM 'string'
      OR coalesce(p_operation->>'expectedRevision','') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'Invalid tenant preview.' USING ERRCODE='22023';END IF;
    v_reason:=p_operation->>'reason';
    IF length(v_reason) NOT BETWEEN 10 AND 500 OR v_reason<>btrim(v_reason) OR v_reason ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'A bounded plain-text reason is required.' USING ERRCODE='22023';END IF;
    v_request_id:=(p_operation->>'requestId')::uuid;v_target_id:=(p_operation->>'targetId')::uuid;
    IF v_request_id IS NULL OR v_target_id IS NULL THEN RAISE EXCEPTION 'Invalid tenant identifiers.' USING ERRCODE='22023';END IF;
    v_suspended:=(p_operation->'parameters'->>'suspended')::boolean;v_next:=CASE WHEN v_suspended THEN 'suspended' ELSE 'active' END;
    PERFORM pg_advisory_xact_lock(hashtextextended('breathe-tenant-request:'||v_request_id::text,0));
    SELECT * INTO v_intent FROM resupply_private.tenant_lifecycle_intents WHERE request_id=v_request_id FOR UPDATE;
    IF FOUND THEN
      IF v_intent.hub_user_id<>v_hub OR v_intent.native_user_id<>v_native OR v_intent.session_id<>v_session
        OR v_intent.target_id<>v_target_id OR v_intent.suspended<>v_suspended OR v_intent.reason<>v_reason
        OR v_intent.before_target->>'revision' IS DISTINCT FROM p_operation->>'expectedRevision' THEN
        RAISE EXCEPTION 'Saved request cannot be reused.' USING ERRCODE='40001';END IF;
      PERFORM resupply_private.tenant_lifecycle_actor(p_actor,p_operation);
      RETURN resupply_private.tenant_lifecycle_view(v_intent,p_actor);
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('breathe-tenant-actor:'||v_hub::text,0));
    IF (SELECT count(*) FROM resupply_private.tenant_lifecycle_intents WHERE hub_user_id=v_hub AND created_at>clock_timestamp()-interval '15 minutes')>=20 THEN
      RAISE EXCEPTION 'Resume an existing tenant review.' USING ERRCODE='42501';END IF;
    SELECT * INTO v_row FROM resupply.organizations WHERE id=v_target_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tenant not found.' USING ERRCODE='P0002';END IF;
    v_target:=resupply_private.tenant_lifecycle_target(v_row);
    IF v_target->>'revision' IS DISTINCT FROM p_operation->>'expectedRevision' THEN RAISE EXCEPTION 'Tenant changed after review.' USING ERRCODE='40001';END IF;
    IF v_row.status='archived' OR v_row.status=v_next OR (v_suspended AND (v_target->>'seedProtected')::boolean) THEN
      RAISE EXCEPTION 'This tenant transition is unavailable.' USING ERRCODE='22023';END IF;
    PERFORM resupply_private.tenant_lifecycle_actor(p_actor,p_operation);v_created:=clock_timestamp();v_command_id:=gen_random_uuid();
    v_expires:=least(v_created+interval '5 minutes',(p_actor->>'assurance_expires_at')::timestamptz);
    IF v_expires<=v_created THEN RAISE EXCEPTION 'Current Hub session expired.' USING ERRCODE='28000';END IF;
    v_digest:=encode(sha256(convert_to(jsonb_build_object('commandId',v_command_id,'requestId',v_request_id,'hubUserId',v_hub,
      'nativeUserId',v_native,'sessionId',v_session,'before',v_target,'parameters',p_operation->'parameters','reason',v_reason)::text,'UTF8')),'hex');
    INSERT INTO resupply_private.tenant_lifecycle_intents(command_id,request_id,hub_user_id,native_user_id,session_id,target_id,before_target,suspended,reason,preview_digest,created_at,expires_at)
      VALUES(v_command_id,v_request_id,v_hub,v_native,v_session,v_target_id,v_target,v_suspended,v_reason,v_digest,v_created,v_expires) RETURNING * INTO v_intent;
    RETURN resupply_private.tenant_lifecycle_view(v_intent,p_actor);
  END IF;
  IF NOT(p_operation ?& ARRAY['domain','operation','commandId','expectedDigest']) OR p_operation-ARRAY['domain','operation','commandId','expectedDigest']<>'{}'::jsonb
    OR coalesce(p_operation->>'expectedDigest','') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid tenant apply.' USING ERRCODE='22023';END IF;
  SELECT * INTO v_intent FROM resupply_private.tenant_lifecycle_intents WHERE command_id=(p_operation->>'commandId')::uuid FOR UPDATE;
  IF NOT FOUND OR v_intent.hub_user_id IS DISTINCT FROM v_hub OR v_intent.native_user_id IS DISTINCT FROM v_native OR v_intent.session_id IS DISTINCT FROM v_session THEN
    RAISE EXCEPTION 'Original tenant review session required.' USING ERRCODE='42501';END IF;
  PERFORM resupply_private.tenant_lifecycle_actor(p_actor,p_operation);
  IF v_intent.preview_digest IS DISTINCT FROM p_operation->>'expectedDigest' THEN RAISE EXCEPTION 'Tenant review digest differs.' USING ERRCODE='40001';END IF;
  IF v_intent.result IS NOT NULL THEN RETURN resupply_private.tenant_lifecycle_view(v_intent,p_actor);END IF;
  SELECT * INTO v_row FROM resupply.organizations WHERE id=v_intent.target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tenant not found.' USING ERRCODE='P0002';END IF;
  v_target:=resupply_private.tenant_lifecycle_target(v_row);
  IF v_target->>'revision' IS DISTINCT FROM v_intent.before_target->>'revision' THEN RAISE EXCEPTION 'Tenant changed after review.' USING ERRCODE='40001';END IF;
  PERFORM resupply_private.tenant_lifecycle_actor(p_actor,p_operation);
  IF v_intent.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Tenant review expired.' USING ERRCODE='40001';END IF;
  v_next:=CASE WHEN v_intent.suspended THEN 'suspended' ELSE 'active' END;
  v_row:=resupply_private.write_tenant_lifecycle_status(v_native,v_intent.target_id,v_next,v_intent.before_target->>'revision',(p_actor->>'assurance_expires_at')::timestamptz);
  v_target:=resupply_private.tenant_lifecycle_target(v_row);
  v_result:=jsonb_build_object('commandId',v_intent.command_id,'requestId',v_intent.request_id,'targetId',v_intent.target_id,'action','organizations.setSuspension',
    'beforeStatus',v_intent.before_target->>'status','afterStatus',v_next,'appliedAt',v_row.updated_at,'revision',v_target->>'revision');
  UPDATE resupply_private.tenant_lifecycle_intents SET result=v_result WHERE command_id=v_intent.command_id RETURNING * INTO v_intent;
  RETURN resupply_private.tenant_lifecycle_view(v_intent,p_actor);
END; $$;

CREATE OR REPLACE FUNCTION resupply_private.protect_tenant_lifecycle_intent()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.result IS NULL AND NEW.result IS NOT NULL AND
    ROW(NEW.command_id,NEW.request_id,NEW.hub_user_id,NEW.native_user_id,NEW.session_id,NEW.target_id,NEW.before_target,NEW.suspended,NEW.reason,NEW.preview_digest,NEW.created_at,NEW.expires_at)
    IS NOT DISTINCT FROM ROW(OLD.command_id,OLD.request_id,OLD.hub_user_id,OLD.native_user_id,OLD.session_id,OLD.target_id,OLD.before_target,OLD.suspended,OLD.reason,OLD.preview_digest,OLD.created_at,OLD.expires_at) THEN RETURN NEW;END IF;
  RAISE EXCEPTION 'Tenant reviews and receipts are immutable.' USING ERRCODE='55000';
END; $$;
DROP TRIGGER IF EXISTS tenant_lifecycle_intent_immutable ON resupply_private.tenant_lifecycle_intents;
CREATE TRIGGER tenant_lifecycle_intent_immutable BEFORE UPDATE OR DELETE ON resupply_private.tenant_lifecycle_intents
  FOR EACH ROW EXECUTE FUNCTION resupply_private.protect_tenant_lifecycle_intent();
REVOKE ALL ON FUNCTION resupply_private.tenant_lifecycle_view(resupply_private.tenant_lifecycle_intents,jsonb),resupply_private.protect_tenant_lifecycle_intent()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION resupply.tenant_lifecycle_command(jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION resupply.tenant_lifecycle_command(jsonb,jsonb) TO service_role;
