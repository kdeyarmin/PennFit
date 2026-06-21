-- 0420_metered_overage_addons — opt-in usage-based OVERAGE billing for the
-- standard plans' SMS / AI / billing-transaction add-ons.
--
-- GATED + reversible. The app only treats these as metered when
-- PLATFORM_METERED_OVERAGE_ENABLED is set (see config). With the flag UNSET
-- (the default), these add-ons bill as the existing FLAT bundles via
-- `recurring_price_cents` exactly as before — so applying this migration
-- changes NOTHING about how any existing tenant bills until an operator
-- deliberately enables + validates the flag (docs/runbooks/
-- stripe-metered-billing-validation.md).
--
-- Model: the PLAN includes an allowance per metric (outboundMessagesPerMonth,
-- etc.); usage beyond it bills per-unit. `metered_unit_amount_decimal` holds
-- the per-unit rate (a string, so sub-cent rates like 7.5¢ are exact) and is
-- kept SEPARATE from `recurring_price_cents` (the flat-bundle price) so the
-- two pricing models don't collide. `included_units` stays NULL here, which
-- marks these as "report only the overage" (vs. the fitter add-on's
-- in-price free tier — migration 0419 — which reports all usage).

ALTER TABLE "resupply"."billing_addons"
  ADD COLUMN IF NOT EXISTS "metered_unit_amount_decimal" text;

-- Per-unit overage rates derived from the existing bundle prices (price ÷
-- 1,000-unit bundle): messages $0.05, AI interactions $0.04, billing
-- transactions $0.075. `usage_metric` already ties each to its plan-allowance
-- key + the monthly usage rollup the app increments.
UPDATE "resupply"."billing_addons"
SET "usage_type" = 'metered',
    "metered_unit_amount_decimal" = '5',
    "updated_at" = now()
WHERE "code" = 'message_bundle';

UPDATE "resupply"."billing_addons"
SET "usage_type" = 'metered',
    "metered_unit_amount_decimal" = '4',
    "updated_at" = now()
WHERE "code" = 'ai_text_bundle';

UPDATE "resupply"."billing_addons"
SET "usage_type" = 'metered',
    "metered_unit_amount_decimal" = '7.5',
    "updated_at" = now()
WHERE "code" = 'billing_transaction_bundle';
