-- 0467_harden_public_tables_and_rpc_grants
--
-- Fixes a hardening migration that was accidentally written under
-- lib/resupply-db/drizzle/ instead of lib/resupply-db/migrations/, so it was
-- never applied by migrate.mjs. Keep this as a new idempotent migration rather
-- than moving or editing the orphaned file.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- Public is PostgREST-exposed. These legacy storefront tables are written and
-- read by the API through the service-role client, so deny-by-default RLS
-- closes direct anon/authenticated Data API access without changing app flows.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name = ANY (ARRAY[
        'newsletter_subscribers',
        'orders',
        'reminder_subscriptions',
        'usage_events'
      ])
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
      r.table_schema,
      r.table_name
    );
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.%I FROM PUBLIC, anon, authenticated',
      r.table_schema,
      r.table_name
    );
    EXECUTE format(
      'GRANT ALL ON TABLE %I.%I TO service_role',
      r.table_schema,
      r.table_name
    );
  END LOOP;
END
$$;
--> statement-breakpoint

-- SECURITY DEFINER functions should not be executable through PostgREST's
-- anon/authenticated roles via the default PUBLIC grant. The API invokes RPCs
-- server-side as service_role, so preserve that role only.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'resupply'
      AND p.prosecdef
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated',
      r.sig
    );
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Search-path hardening from the orphaned 0394 file. Guard by name and
-- signature so partial databases and future drops stay safe.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'resupply'
      AND p.proname = ANY (ARRAY[
        'increment_tenant_usage_rollup',
        'platform_tenant_usage_snapshot',
        'record_fitter_touch_open',
        'reset_phone_line_type_on_phone_change',
        'set_bulk_campaign_recipients_updated_at',
        'set_platform_contacts_updated_at',
        'set_platform_email_campaigns_updated_at',
        'set_platform_email_recipients_updated_at'
      ])
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %s SET search_path = pg_catalog, resupply',
      r.sig
    );
  END LOOP;
END
$$;
