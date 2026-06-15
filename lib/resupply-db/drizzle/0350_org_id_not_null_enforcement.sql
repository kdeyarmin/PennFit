-- 0350_org_id_not_null_enforcement — tighten org_id to NOT NULL.
-- Phase 0, plan workstream D ("Finishing enforcement", step 1).
--
-- See docs/multi-tenant-phase-0-engineering-plan-2026-06-14.md and
-- docs/multi-tenant-cutover-playbook-2026-06-14.md.
--
-- WHAT
--   Sets `org_id NOT NULL` on every tenant-scoped table in the `resupply`
--   schema whose column is still nullable AND currently holds no NULL
--   rows. This is the data-integrity capstone of the cutover: now that
--   EVERY writer (routes AND workers) reaches Postgres through
--   getOrgScopedClient(orgId) — which forces org_id onto every
--   insert/upsert — and the tenant-isolation guard's baseline has reached
--   empty, a NULL org_id is no longer reachable from application code, so
--   the column can be constrained to match.
--
-- WHY IT IS SAFE (no behavior change, never fails the apply)
--   * The org_id backfill (migrations 0331–0342) is complete: a live
--     audit found ZERO NULL org_id rows on every tenant table except
--     `feature_flags`. SET NOT NULL on a clean column only constrains
--     FUTURE inserts, which the facade already satisfies.
--   * Defense in depth against an environment whose backfill differs:
--     the loop COUNTS NULLs per table first and SKIPS (with a NOTICE) any
--     table that still has one, so the migration can never abort a
--     deploy. The gated migrator keeps the prior release running on any
--     error regardless (CLAUDE.md), so this is belt-and-suspenders.
--
-- WHY feature_flags IS EXCLUDED
--   `feature_flags` carries org_id but is GLOBAL by design: a NULL org_id
--   row is a platform-wide flag, a non-NULL row a per-tenant override.
--   The code reaches it through the chokepoint's `.raw()` escape hatch
--   (it is a catalog, not tenant data), so its org_id must stay nullable.
--
-- WHY A CATALOG LOOP (not a hand-maintained table list)
--   Mirrors 0170 / 0348: iterate the live catalog for columns that
--   actually exist and are still nullable. Correct by construction (can't
--   name a missing column or miss a table) and idempotent — a re-run only
--   considers columns that are still nullable, so already-tightened
--   tables fall out of the set and the statement is a no-op.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent. This file
-- is a single DO block with no statement-breakpoint markers, so the
-- migrator runs it as ONE statement and its internal semicolons are not
-- mis-split. (Do not write the breakpoint marker anywhere in this file,
-- even inside a comment — the splitter matches it as a literal substring.)

DO $$
DECLARE
  r record;
  null_count bigint;
BEGIN
  FOR r IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'resupply'
      AND c.relkind = 'r'             -- ordinary tables only (no views/matviews)
      AND a.attname = 'org_id'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.attnotnull = false        -- only columns still nullable
      AND c.relname <> 'feature_flags' -- intentionally global (NULL = platform-wide)
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM resupply.%I WHERE org_id IS NULL',
      r.table_name
    ) INTO null_count;

    IF null_count = 0 THEN
      EXECUTE format(
        'ALTER TABLE resupply.%I ALTER COLUMN org_id SET NOT NULL',
        r.table_name
      );
    ELSE
      RAISE NOTICE
        'org_id NOT NULL skipped for resupply.% (% NULL row(s) present)',
        r.table_name, null_count;
    END IF;
  END LOOP;
END
$$;
