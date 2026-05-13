-- 0113_storefront_enable_rls — close the Supabase "RLS Disabled in Public"
-- and "Sensitive Columns Exposed" advisor findings for the four
-- storefront tables that live in the default `public` schema:
--
--   * public.orders
--   * public.usage_events
--   * public.admin_audit_log
--   * public.reminder_subscriptions
--
-- Why enable RLS with no policies?
--   Every runtime read/write to these tables goes through the
--   Supabase service-role client exported from
--   `@workspace/resupply-db` (`getSupabaseServiceRoleClient()`),
--   and the service-role key BYPASSES row-level security by design.
--   So toggling `ENABLE ROW LEVEL SECURITY` here:
--     * Has zero effect on the API process (still uses service-role,
--       still sees every row).
--     * Slams the door on anon/authenticated PostgREST access — without
--       a policy, RLS denies every non-bypass role by default. That is
--       exactly what we want: these tables must never be queryable from
--       the browser-facing publishable/anon key, no matter how the
--       project's "Exposed schemas" setting ends up configured.
--
--   This matches the model already in use for the `resupply.*` and
--   `resupply_auth.*` schemas, which are not exposed via PostgREST at
--   all. The four storefront tables predate that consolidation and
--   live in `public`, so they need an explicit RLS toggle instead of
--   the schema-level exclusion.
--
-- Idempotency:
--   `ENABLE ROW LEVEL SECURITY` is a no-op when RLS is already on, so
--   re-running the migration against a DB where this has been applied
--   manually is safe.

ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."usage_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."admin_audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."reminder_subscriptions" ENABLE ROW LEVEL SECURITY;
