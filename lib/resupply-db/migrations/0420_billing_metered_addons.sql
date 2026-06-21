-- 0420_billing_metered_addons — usage-based (metered) billing for catalog
-- add-ons, wired to Stripe Billing Meters.
--
-- ADDITIVE / idempotent. `usage_type` DEFAULTS to NULL (= licensed/flat),
-- so every existing add-on, plan, and tenant subscription bills EXACTLY as
-- before — the metered code path in the Stripe sync only runs for a row
-- whose `usage_type` is 'metered'. Only the standalone Virtual Mask Fitter
-- per-fitting add-on (migration 0419) is flipped here.
--
-- Billing Meters (not legacy usage records) because the platform
-- subscription sync deletes + recreates subscription items on every change;
-- meter events are keyed by CUSTOMER, so reported usage survives that
-- recreation. The metered Stripe Price references the meter and carries a
-- graduated tier so the first `included_units` each month are free.

ALTER TABLE "resupply"."billing_addons"
  ADD COLUMN IF NOT EXISTS "usage_type" text,
  ADD COLUMN IF NOT EXISTS "included_units" integer,
  ADD COLUMN IF NOT EXISTS "meter_event_name" text,
  ADD COLUMN IF NOT EXISTS "stripe_meter_id" text;

ALTER TABLE "resupply"."billing_addons"
  DROP CONSTRAINT IF EXISTS "billing_addons_usage_type_chk";
ALTER TABLE "resupply"."billing_addons"
  ADD CONSTRAINT "billing_addons_usage_type_chk"
  CHECK ("usage_type" IS NULL OR "usage_type" IN ('licensed', 'metered'));

ALTER TABLE "resupply"."billing_addons"
  DROP CONSTRAINT IF EXISTS "billing_addons_included_units_chk";
ALTER TABLE "resupply"."billing_addons"
  ADD CONSTRAINT "billing_addons_included_units_chk"
  CHECK ("included_units" IS NULL OR "included_units" >= 0);

-- Flip the per-fitting add-on to metered: usage billed via a Stripe Billing
-- Meter (event 'fitter_fitting'). `included_units` = 25 mirrors the Virtual
-- Mask Fitter plan's `fitterFittingsPerMonth` allowance — the metered price's
-- first tier covers those 25 at $0, then $3.00 (recurring_price_cents) each.
-- Keep the two in sync if the plan's included amount changes.
UPDATE "resupply"."billing_addons"
SET "usage_type" = 'metered',
    "included_units" = 25,
    "meter_event_name" = 'fitter_fitting',
    "updated_at" = now()
WHERE "code" = 'fitter_fitting_metered';
