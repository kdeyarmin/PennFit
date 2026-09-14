-- Preserve the shipped pricing definitions and their grants while changing only
-- explicit business-conflict signals. Affected PostgREST versions can retry a custom
-- serialization_failure forever. PT409 is a deterministic HTTP conflict.
-- Real serialization errors raised by PostgreSQL itself remain unchanged.
DO $migration$
DECLARE signature text; routine regprocedure; original text; updated text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'resupply.pricing_assert_dependencies(uuid,jsonb)',
    'resupply.pricing_assert_quote_current(uuid,uuid,integer)',
    'resupply.pricing_mutate(uuid,text,text,jsonb)',
    'resupply.create_csr_priced_order(uuid,uuid,integer,uuid,jsonb)',
    'resupply.save_csr_delivery_review(uuid,uuid,text,jsonb)',
    'resupply.approve_csr_delivery_review(uuid,uuid,uuid,text,integer,text,boolean)'
  ] LOOP
    routine := to_regprocedure(signature);
    IF routine IS NULL THEN RAISE EXCEPTION 'Missing required pricing routine: %',signature; END IF;
    original := pg_get_functiondef(routine);
    updated := regexp_replace(original, $pattern$ERRCODE\s*=\s*'40001'$pattern$, 'ERRCODE=''PT409''', 'gi');
    IF original = updated AND strpos(original,'''PT409''') = 0 THEN
      RAISE EXCEPTION 'Expected pricing conflict signals not found: %',signature;
    END IF;
    EXECUTE updated;
  END LOOP;

  routine := to_regprocedure('resupply.pricing_apply_scheduled(uuid)');
  IF routine IS NULL THEN RAISE EXCEPTION 'Missing required pricing scheduler'; END IF;
  original := pg_get_functiondef(routine);
  updated := replace(original,
    'CASE WHEN SQLSTATE=''40001'' THEN ''stale_dependencies'' ELSE ''blocked_pricing'' END',
    'CASE WHEN SQLERRM=''price_list_contexts_changed'' THEN ''price_list_contexts_changed'' WHEN SQLSTATE IN (''40001'',''PT409'') THEN ''stale_dependencies'' ELSE ''blocked_pricing'' END');
  IF original = updated AND strpos(original,'SQLERRM=''price_list_contexts_changed''') = 0 THEN
    RAISE EXCEPTION 'Expected pricing scheduler error classification not found';
  END IF;
  EXECUTE updated;
END;
$migration$;
