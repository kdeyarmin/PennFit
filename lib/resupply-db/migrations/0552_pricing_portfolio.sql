-- Search the canonical active catalog and currently effective supplier versions
-- before pagination. No browser role can execute this internal pricing API.
CREATE FUNCTION resupply.pricing_portfolio(
  p_org_id uuid, p_q text DEFAULT NULL, p_category text DEFAULT NULL,
  p_supplier text DEFAULT NULL, p_offset integer DEFAULT 0, p_limit integer DEFAULT 51,
  p_active_offer_ids uuid[] DEFAULT NULL
) RETURNS TABLE(sku text, name text, category text, offers jsonb, has_more_offers boolean, matching_offer_ids uuid[], active_suppliers jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  WITH current_offers AS MATERIALIZED (
    SELECT DISTINCT ON (o.id) o.* FROM resupply.pricing_offers o
    WHERE o.org_id = p_org_id AND o.effective_from <= statement_timestamp()
    ORDER BY o.id, o.version DESC
  ), selected AS (
    SELECT p.sku, p.name, p.category FROM resupply.products p
    WHERE p.org_id = p_org_id AND p.active
      AND (NULLIF(btrim(p_q),'') IS NULL OR strpos(lower(p.sku || ' ' || p.name), lower(btrim(p_q))) > 0)
      AND (NULLIF(btrim(p_category),'') IS NULL OR p.category = btrim(p_category))
      AND (NULLIF(btrim(p_supplier),'') IS NULL OR EXISTS (
        SELECT 1 FROM current_offers o WHERE o.sku = p.sku
          AND strpos(lower(o.data->>'supplierName'), lower(btrim(p_supplier))) > 0
      ))
    ORDER BY p.sku
    OFFSET GREATEST(0, LEAST(COALESCE(p_offset,0),100000))
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit,51),101))
  )
  SELECT p.sku,p.name,p.category,
    COALESCE(jsonb_agg(to_jsonb(o) - 'position' ORDER BY o.id) FILTER(WHERE o.id IS NOT NULL AND o.position <= 100),'[]'::jsonb),
    COALESCE(max(o.position),0) > 100,
    ARRAY(SELECT matching.id FROM current_offers matching WHERE matching.sku = p.sku
      AND matching.id = ANY(p_active_offer_ids)
      AND (NULLIF(btrim(p_supplier),'') IS NULL OR strpos(lower(matching.data->>'supplierName'),lower(btrim(p_supplier))) > 0)
      ORDER BY matching.id),
    COALESCE((SELECT jsonb_agg(jsonb_build_object('sku',supplier.sku,'offerId',supplier.id,'supplierName',supplier.data->>'supplierName') ORDER BY supplier.id)
      FROM current_offers supplier WHERE supplier.sku = p.sku AND supplier.id = ANY(p_active_offer_ids)), '[]'::jsonb)
  FROM selected p
  LEFT JOIN LATERAL (
    SELECT candidate.*, row_number() OVER(ORDER BY candidate.id) AS position
    FROM current_offers candidate WHERE candidate.sku = p.sku
    ORDER BY candidate.id LIMIT 101
  ) o ON true
  GROUP BY p.sku,p.name,p.category ORDER BY p.sku;
$$;
REVOKE ALL ON FUNCTION resupply.pricing_portfolio(uuid,text,text,text,integer,integer,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION resupply.pricing_portfolio(uuid,text,text,text,integer,integer,uuid[]) TO service_role;

-- The preview read and save must agree on the source list: a concurrent publish
-- cannot be overwritten by a snapshot assembled before its new contexts existed.
-- PT409 is a deterministic business conflict. Do not use serialization_failure
-- (40001): older PostgREST versions retry that code indefinitely.
CREATE FUNCTION resupply.pricing_save_portfolio_batch(
  p_org_id uuid,p_actor text,p_expected_active_price_list_id uuid,p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE s resupply.pricing_state;
BEGIN
  s := resupply.pricing_lock_state(p_org_id);
  IF s.active_price_list_id IS DISTINCT FROM p_expected_active_price_list_id THEN
    RAISE EXCEPTION 'price_list_contexts_changed' USING ERRCODE='PT409';
  END IF;
  RETURN resupply.pricing_mutate(p_org_id,p_actor,'batch',p_payload);
END;
$$;
REVOKE ALL ON FUNCTION resupply.pricing_save_portfolio_batch(uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION resupply.pricing_save_portfolio_batch(uuid,text,uuid,jsonb) TO service_role;

-- Manual activation, rollback and scheduled activation share this atomic gate.
-- A stale preview may update amounts, but may never silently remove a context
-- added by an intervening publication. Explicit policy reset to NULL is separate.
CREATE FUNCTION resupply.pricing_preserve_active_contexts() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE old_entries jsonb; new_entries jsonb; old_keys text[]; new_keys text[];
  retained jsonb; retained_key text; previous jsonb; retained_amounts jsonb; previous_amounts jsonb;
BEGIN
  IF OLD.active_price_list_id IS NULL OR NEW.active_price_list_id IS NULL OR
     OLD.active_price_list_id = NEW.active_price_list_id THEN RETURN NEW; END IF;
  SELECT entries INTO old_entries FROM resupply.pricing_price_lists WHERE org_id=OLD.org_id AND id=OLD.active_price_list_id;
  SELECT entries INTO new_entries FROM resupply.pricing_price_lists WHERE org_id=NEW.org_id AND id=NEW.active_price_list_id;
  SELECT array_agg((entry->'scenario'->'revenue'->>'mode') || ':' ||
    COALESCE((SELECT string_agg((line->>'sku') || ':' || (line->>'quantity'),'|' ORDER BY line->>'sku',line->>'quantity')
      FROM jsonb_array_elements(entry->'scenario'->'lines') line),''))
    INTO old_keys FROM jsonb_array_elements(old_entries) entry;
  SELECT array_agg((entry->'scenario'->'revenue'->>'mode') || ':' ||
    COALESCE((SELECT string_agg((line->>'sku') || ':' || (line->>'quantity'),'|' ORDER BY line->>'sku',line->>'quantity')
      FROM jsonb_array_elements(entry->'scenario'->'lines') line),''))
    INTO new_keys FROM jsonb_array_elements(new_entries) entry;
  IF EXISTS(SELECT 1 FROM unnest(old_keys) old_key WHERE old_key IS NOT NULL AND NOT old_key = ANY(COALESCE(new_keys,ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'price_list_contexts_changed' USING ERRCODE='PT409';
  END IF;
  -- Retained rows are an unchanged subset, not authorization to restore old
  -- amounts changed by a later manager. Scheduled execution uses the same gate.
  FOR retained IN SELECT entry FROM jsonb_array_elements(new_entries) entry WHERE entry->>'changeKind'='retained' LOOP
    SELECT (retained->'scenario'->'revenue'->>'mode') || ':' ||
      string_agg((line->>'sku') || ':' || (line->>'quantity'),'|' ORDER BY line->>'sku',line->>'quantity')
      INTO retained_key FROM jsonb_array_elements(retained->'scenario'->'lines') line;
    SELECT entry INTO previous FROM jsonb_array_elements(old_entries) entry WHERE
      (entry->'scenario'->'revenue'->>'mode') || ':' ||
        (SELECT string_agg((line->>'sku') || ':' || (line->>'quantity'),'|' ORDER BY line->>'sku',line->>'quantity')
          FROM jsonb_array_elements(entry->'scenario'->'lines') line) = retained_key;
    SELECT jsonb_agg(jsonb_build_array(line->>'sku',line->'quantity',line->'unitAmountCents') ORDER BY line->>'sku',line->>'quantity')
      INTO retained_amounts FROM jsonb_array_elements(retained->'scenario'->'lines') line;
    SELECT jsonb_agg(jsonb_build_array(line->>'sku',line->'quantity',line->'unitAmountCents') ORDER BY line->>'sku',line->>'quantity')
      INTO previous_amounts FROM jsonb_array_elements(previous->'scenario'->'lines') line;
    IF retained_amounts IS DISTINCT FROM previous_amounts THEN
      RAISE EXCEPTION 'price_list_contexts_changed' USING ERRCODE='PT409';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION resupply.pricing_preserve_active_contexts() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION resupply.pricing_preserve_active_contexts() TO service_role;
CREATE TRIGGER pricing_state_preserve_contexts BEFORE UPDATE OF active_price_list_id ON resupply.pricing_state
FOR EACH ROW EXECUTE FUNCTION resupply.pricing_preserve_active_contexts();
