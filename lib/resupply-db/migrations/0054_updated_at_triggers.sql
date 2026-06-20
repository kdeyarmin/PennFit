-- D-16: BEFORE UPDATE triggers to keep updated_at current on writes
-- that bypass Drizzle ORM (raw SQL migrations, admin psql sessions,
-- future background jobs).
--
-- Strategy:
--   A single shared trigger function `resupply.set_updated_at()` is
--   created ONCE and reused by every table. Postgres calls the function
--   per-row; NEW is the candidate row after the application's SET
--   clauses, so stamping `NEW.updated_at = now()` there ensures the
--   column is always current regardless of what the caller wrote.
--
-- Tables targeted: the five most-written mutable tables whose stale
-- `updated_at` would mislead the CSR dashboard's "last updated" column
-- or block cache invalidation logic. Other tables with `updated_at`
-- continue to rely on Drizzle's `.$onUpdateFn()` marker at the ORM
-- layer; those can be added here if they grow raw-SQL writers.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE OR REPLACE FUNCTION resupply.set_updated_at()
  RETURNS TRIGGER
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_patients_set_updated_at
  BEFORE UPDATE ON resupply.patients
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_shop_orders_set_updated_at
  BEFORE UPDATE ON resupply.shop_orders
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_shop_customers_set_updated_at
  BEFORE UPDATE ON resupply.shop_customers
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_conversations_set_updated_at
  BEFORE UPDATE ON resupply.conversations
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();

CREATE TRIGGER trg_csr_macros_set_updated_at
  BEFORE UPDATE ON resupply.csr_macros
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();
