-- 0398 — Reset the phone line-type cache when a phone number changes.
--
-- 0397 added cached phone_line_type columns to patients + shop_customers.
-- The cache is keyed to a specific number, so when phone_e164 changes (admin
-- edit, portal-invite, merge, any current/future write path) the cached
-- classification is stale: a mobile number replaced with a landline would
-- otherwise keep its 'mobile' value and bulk SMS would keep treating the new
-- number as a cell. A BEFORE UPDATE trigger invalidates the cache (back to
-- NULL = unclassified) whenever the number actually changes, so the nightly
-- backfill re-classifies it. A row-level trigger catches EVERY write path,
-- which a per-route invalidation could not.
--
-- A manual override (phone_line_type set via PATCH without changing the
-- phone) is preserved — the trigger only fires when phone_e164 itself is
-- DISTINCT FROM the old value.
--
-- IMPORTANT — journal posture: not listed in _journal.json, matching the
-- established pattern for migrations 0050+. Idempotent: CREATE OR REPLACE
-- FUNCTION + DROP TRIGGER IF EXISTS then CREATE.

CREATE OR REPLACE FUNCTION "resupply"."reset_phone_line_type_on_phone_change"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."phone_e164" IS DISTINCT FROM OLD."phone_e164" THEN
    NEW."phone_line_type" := NULL;
    NEW."phone_line_type_source" := NULL;
    NEW."phone_line_type_checked_at" := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "patients_reset_phone_line_type"
  ON "resupply"."patients";
CREATE TRIGGER "patients_reset_phone_line_type"
  BEFORE UPDATE ON "resupply"."patients"
  FOR EACH ROW
  EXECUTE FUNCTION "resupply"."reset_phone_line_type_on_phone_change"();

DROP TRIGGER IF EXISTS "shop_customers_reset_phone_line_type"
  ON "resupply"."shop_customers";
CREATE TRIGGER "shop_customers_reset_phone_line_type"
  BEFORE UPDATE ON "resupply"."shop_customers"
  FOR EACH ROW
  EXECUTE FUNCTION "resupply"."reset_phone_line_type_on_phone_change"();
