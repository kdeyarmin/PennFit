-- 0346_org_isolation_rls_policies — multi-tenant RLS backstop.
-- Phase 0, plan workstream D (the defense-in-depth layer).
--
-- See docs/multi-tenant-phase-0-engineering-plan-2026-06-14.md.
--
-- WHAT
--   Adds a per-tenant Row Level Security policy `org_isolation` to every
--   tenant-scoped table in the `resupply` schema — i.e. every table that
--   carries an `org_id` column (added in the 0331–0342 backfill batches).
--   The policy constrains both reads and writes to the request's active
--   tenant:
--       USING / WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid)
--
-- WHY IT IS RUNTIME-INERT TODAY (no behavior change)
--   The ONLY runtime data path is the Supabase `service_role` client
--   (CLAUDE.md), and `service_role` has rolbypassrls=true — it ignores
--   RLS entirely, exactly like `postgres` (migrate.mjs / CI). The
--   app-layer chokepoint `getOrgScopedClient(orgId)` is therefore what
--   actually separates tenants right now; this policy is the BACKSTOP for
--   the day any access moves to a non-bypassing role, plus the evidence
--   artifact a BAA / SOC 2 review expects. RLS is already ENABLED on every
--   resupply table (migration 0170) with anon/authenticated grants revoked
--   (0169), so before this migration these tables were "RLS enabled, no
--   policy" = deny-all to non-bypass roles. Adding a policy keyed on an
--   unset GUC keeps that posture: `current_setting(..., true)` returns
--   NULL when `app.current_org_id` is not set, `org_id = NULL` is never
--   true, so a non-bypass role still sees nothing until the GUC is set
--   per request/txn (which the wrapper will do when workstream D's GUC
--   wiring lands — see org-scoped-client.ts). service_role is unaffected
--   either way.
--
-- WHY A CATALOG LOOP (not a hand-maintained table list)
--   Mirrors 0170's approach: iterate the live catalog for tables that
--   actually have an `org_id` column. This makes the migration correct by
--   construction (it can't name a non-existent column or miss a table)
--   and idempotent — DROP POLICY IF EXISTS before CREATE means re-running
--   is a no-op, and any tenant table added before this migration is
--   covered automatically.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent. This
-- file is a single DO block with no statement-breakpoint markers, so the
-- migrator runs it as ONE statement and its internal semicolons are not
-- mis-split. (Do not write the breakpoint marker anywhere in this file,
-- even inside a comment — the splitter matches it as a literal substring.)

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'resupply'
      AND c.relkind = 'r'            -- ordinary tables only (no views/matviews)
      AND a.attname = 'org_id'
      AND a.attnum > 0
      AND NOT a.attisdropped
  LOOP
    EXECUTE format(
      'ALTER TABLE resupply.%I ENABLE ROW LEVEL SECURITY',
      r.table_name
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS org_isolation ON resupply.%I',
      r.table_name
    );
    EXECUTE format(
      'CREATE POLICY org_isolation ON resupply.%I '
      'USING (org_id = current_setting(''app.current_org_id'', true)::uuid) '
      'WITH CHECK (org_id = current_setting(''app.current_org_id'', true)::uuid)',
      r.table_name
    );
  END LOOP;
END
$$;
