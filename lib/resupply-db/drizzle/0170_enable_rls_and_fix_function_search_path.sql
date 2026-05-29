-- Defense-in-depth hardening to clear the remaining Supabase security
-- advisor findings, complementing 0169 (which revoked anon/authenticated
-- grants on the resupply schemas).
--
-- 1. ENABLE ROW LEVEL SECURITY on every ordinary table in the `resupply`
--    and `resupply_auth` schemas. Both schemas are exposed to PostgREST
--    (required so the service-role client can reach them), and the
--    advisor flags every table in an exposed schema that has RLS off as
--    an ERROR (`rls_disabled_in_public`) plus `sensitive_columns_exposed`
--    for the patient_id columns.
--
--    This is safe with zero app impact: `service_role` (the ONLY runtime
--    data path — see CLAUDE.md) has rolbypassrls=true and ignores RLS
--    entirely, as does `postgres` (used by migrate.mjs and local/CI dev).
--    The `anon`/`authenticated` roles already lost every grant in 0169,
--    so enabling RLS with no policy makes these tables deny-all to any
--    non-bypass role — the correct, intended posture for a
--    service-role-only schema. (The advisor will downgrade these from
--    ERROR `rls_disabled_in_public` to INFO `rls_enabled_no_policy`,
--    which is the accepted end-state here: a deny-all table is exactly
--    what "RLS enabled, no policy" means.)
--
--    Done as a loop over the live catalog (relrowsecurity=false) so it is
--    idempotent and automatically covers any table added before this
--    migration without hand-maintaining a list. relkind='r' excludes
--    views/matviews (which cannot carry RLS).
--
-- 2. Pin a non-mutable search_path on the three functions the advisor
--    flagged (`function_search_path_mutable`, WARN). All three are
--    SECURITY INVOKER with fully-qualified bodies, so a fixed search_path
--    does not change behavior — it just removes the role-mutable-path
--    warning. The pgboss_resupply.* functions are created by the pg-boss
--    library at runtime, NOT by these migrations, so a from-scratch
--    replay (fresh local/CI DB) won't have them yet; each ALTER is
--    therefore guarded with to_regprocedure() (which returns NULL instead
--    of erroring when the function is absent), mirroring the existence
--    guards used in 0143/0164. (If pg-boss is upgraded and recreates its
--    functions, it may reset their search_path; re-running this migration
--    or a follow-up re-applies it.)
--
-- Idempotent + from-scratch safe throughout. migrate.mjs dedups by file
-- hash so this runs once per database; re-running is harmless.

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('resupply', 'resupply_auth')
      AND c.relkind = 'r'
      AND c.relrowsecurity = false
    ORDER BY 1, 2
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
      r.schema_name, r.table_name
    );
  END LOOP;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF to_regprocedure('resupply.set_updated_at()') IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION resupply.set_updated_at() SET search_path = ''''';
  END IF;
  IF to_regprocedure('pgboss_resupply.create_queue(text, json)') IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION pgboss_resupply.create_queue(text, json) SET search_path = pgboss_resupply, pg_catalog';
  END IF;
  IF to_regprocedure('pgboss_resupply.delete_queue(text)') IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION pgboss_resupply.delete_queue(text) SET search_path = pgboss_resupply, pg_catalog';
  END IF;
END
$$;
