-- 0394_harden_rpc_grants_and_newsletter_rls — close the database-linter
-- security findings surfaced by Supabase's advisor on the resupply project.
--
-- Three hardening changes, none of which alter application behavior (the
-- app reaches Postgres only through the service-role client, which keeps
-- every grant it needs and bypasses RLS):
--
--   1. ERROR `rls_disabled_in_public` — `public.newsletter_subscribers`
--      (migration 0354) is a PostgREST-exposed table with RLS OFF, so the
--      anon/authenticated roles could read/write the whole marketing list
--      directly. The app only ever writes it via the service-role client
--      (routes/storefront/{newsletter,demo-lead}.ts → getOrgScopedClient().raw()),
--      which BYPASSes RLS — so enabling RLS with no policy (deny-all to
--      anon/authenticated) closes the hole without touching the signup path.
--
--   2. WARN `{anon,authenticated}_security_definer_function_executable` —
--      27 SECURITY DEFINER RPCs in `resupply` are EXECUTE-able by
--      anon/authenticated via the default PUBLIC grant. They run with the
--      definer's (owner) privileges and several mutate billing / patient
--      data (apply_patient_payment, merge_patient_records,
--      swap_tenant_subscription, submit_inventory_reconciliation, …), so a
--      leaked publishable key could call them straight over /rest/v1/rpc.
--      Every one is invoked server-side through the service-role client
--      (grep `.rpc("…")`), so we REVOKE EXECUTE from PUBLIC/anon/authenticated
--      and keep the explicit service_role grant.
--
--   3. WARN `function_search_path_mutable` — 8 helper/trigger functions have
--      no pinned search_path. They are all SECURITY INVOKER and fully
--      schema-qualify their table references, so pinning the path to
--      `pg_catalog, resupply` is behavior-preserving and removes the
--      search-path-injection surface.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent: re-running
-- ENABLE RLS, REVOKE/GRANT, and ALTER FUNCTION … SET are all no-ops the
-- second time. Guarded against vanilla Postgres (CI replay), which has no
-- anon/authenticated/service_role roles and may not have every function.

-- Roles guard — vanilla Postgres (CI replay) has none of the Supabase roles,
-- so create them NOLOGIN if absent before any GRANT/REVOKE references them.
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

-- (1) Enable RLS on the public marketing table. No policy = deny-all to
-- anon/authenticated; the service-role writer bypasses RLS and is unaffected.
DO $$
BEGIN
  IF to_regclass('public.newsletter_subscribers') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.newsletter_subscribers ENABLE ROW LEVEL SECURITY';
  END IF;
END
$$;
--> statement-breakpoint

-- (2) Lock down the SECURITY DEFINER RPCs: drop the implicit PUBLIC execute
-- (which is what exposes anon/authenticated) and keep only service_role.
-- Looping over oid::regprocedure handles every overload and tolerates a
-- function being absent on a partially-built DB.
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
        'acquisition_funnel_steps',
        'apply_patient_payment',
        'assign_tenant_subscription',
        'billing_denial_rate',
        'billing_denial_risk',
        'fulfillments_to_bill_count',
        'location_rollup',
        'merge_patient_records',
        'metrics_daily_latest',
        'patient_duplicate_groups',
        'patient_maintenance_latest_by_task',
        'patients_with_therapy_anniversary',
        'payer_oop_samples',
        'resolve_compliance_thresholds',
        'resolve_compliance_window',
        'shop_back_in_stock_queue',
        'shop_customers_last_paid_at',
        'submit_inventory_reconciliation',
        'swap_tenant_subscription',
        'therapy_clinical_metrics',
        'therapy_clinical_signal_counts',
        'therapy_fleet_overview',
        'therapy_fleet_worklist',
        'therapy_resupply_opportunities',
        'therapy_resupply_summary',
        'therapy_setup_adherence_list',
        'therapy_setup_adherence_summary'
      ])
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

-- (3) Pin search_path on the 8 flagged helper/trigger functions. They are
-- SECURITY INVOKER and fully qualify their refs, so this is behavior-safe.
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
