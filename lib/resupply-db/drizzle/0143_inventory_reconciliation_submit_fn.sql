-- 0143_inventory_reconciliation_submit_fn — atomic submit RPC for
-- the reconciliation workflow added in 0142.
--
-- Why an RPC (vs three sequential Supabase JS calls): the submit
-- path writes lines + flips the header in one logical operation.
-- Doing that as separate Supabase calls leaves a race + partial-
-- failure window where a header update can crash after lines are
-- already persisted, leaving the reconciliation stuck in `draft`
-- with a duplicate-key constraint blocking any retry.
--
-- Stripe writes remain OUTSIDE this transaction by necessity —
-- there is no way to roll back an external HTTP call. The route
-- still does Stripe updates before calling this function and
-- passes each line's per-row `applied` flag in so the
-- audit-of-record reflects what was actually pushed.

CREATE OR REPLACE FUNCTION resupply.submit_inventory_reconciliation(
  p_id uuid,
  p_lines jsonb,
  p_applied_to_stripe boolean,
  p_total_variance_units integer
) RETURNS jsonb
LANGUAGE plpgsql
-- SECURITY DEFINER so the function inherits the migrator's privileges
-- on the resupply schema. The function is only callable from the
-- service-role JWT (see GRANT below); the storefront anon role never
-- gets here.
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
DECLARE
  v_status   text;
  v_inserted integer;
BEGIN
  -- Row-level lock + status check in one shot. FOR UPDATE blocks a
  -- concurrent submit on the same reconciliation until this txn
  -- commits, eliminating the lost-update race even when two operators
  -- hit submit milliseconds apart.
  SELECT status INTO v_status
    FROM resupply.inventory_reconciliations
    WHERE id = p_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_status <> 'draft' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_submitted');
  END IF;

  -- Bulk insert from the JSONB payload. The `applied` flag is set by
  -- the caller per-row (true iff the matching Stripe update succeeded
  -- in the route's apply loop) so the persisted line row reflects
  -- actual external state, not intent.
  INSERT INTO resupply.inventory_reconciliation_lines (
    reconciliation_id,
    product_id,
    product_name,
    system_count,
    counted_qty,
    variance,
    applied
  )
  SELECT
    p_id,
    (line->>'product_id')::text,
    (line->>'product_name')::text,
    NULLIF(line->>'system_count', '')::integer,
    (line->>'counted_qty')::integer,
    (line->>'variance')::integer,
    COALESCE((line->>'applied')::boolean, false)
  FROM jsonb_array_elements(p_lines) AS line;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  UPDATE resupply.inventory_reconciliations
     SET status               = 'submitted',
         submitted_at         = now(),
         total_lines          = v_inserted,
         total_variance_units = p_total_variance_units,
         applied_to_stripe    = p_applied_to_stripe
   WHERE id = p_id;

  RETURN jsonb_build_object(
    'ok', true,
    'total_lines', v_inserted,
    'total_variance_units', p_total_variance_units
  );

EXCEPTION
  -- A duplicate (reconciliation_id, product_id) inside the input
  -- payload would surface here. The route already pre-filters
  -- duplicates, so this is defense in depth — surface a clean error
  -- code so the route can log + 400 instead of leaking a 23505.
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'error', 'duplicate_line');
END;
$$;

-- Allow the Supabase service-role JWT (the only key the resupply API
-- uses) to call this. anon / authenticated never get here.
GRANT EXECUTE ON FUNCTION resupply.submit_inventory_reconciliation(uuid, jsonb, boolean, integer) TO service_role;
