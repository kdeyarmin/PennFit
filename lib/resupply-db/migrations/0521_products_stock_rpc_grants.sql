-- 0521_products_stock_rpc_grants — lock down the stock-movement RPC.
--
-- WHY (cross-tenant inventory write)
--   0520 created resupply.adjust_product_stock(...) as SECURITY DEFINER
--   taking an explicit p_org_id, and `resupply` is a PostgREST-exposed
--   schema. Being created AFTER 0468's one-time hardening sweep, the
--   function carries PostgreSQL's DEFAULT PUBLIC EXECUTE grant — so an
--   anon/authenticated Data API caller could invoke it directly for ANY
--   tenant: decrement a competitor's on-hand to zero, inflate their
--   counts, or write ledger rows with a forged reason/reference. The
--   definer context means the function's own advisory lock and checks
--   run happily on their behalf; nothing else stands between the caller
--   and another org's inventory.
--
--   The API only ever calls this server-side through the service-role
--   client (lib/catalog/store.ts → adjustStock), so revoking the public
--   grant costs the application nothing.
--
-- Mirrors the convention 0469 established for exactly this situation.
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

-- Ensure the PostgREST roles exist so the REVOKE below is safe on a
-- from-scratch / vanilla-Postgres replay (0468 creates them, but guard
-- here too so this migration is self-contained).
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

REVOKE EXECUTE ON FUNCTION resupply.adjust_product_stock(
  uuid, text, int, text, text, text, text
) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION resupply.adjust_product_stock(
  uuid, text, int, text, text, text, text
) TO service_role;
