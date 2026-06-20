-- 0358_platform_billing_stripe — Stripe linkage for platform tenant billing.
--
-- The platform billing catalog remains editable in CareMetric Breathe, while
-- Stripe owns actual recurring tenant collection. These columns connect catalog
-- rows and tenant assignments to Stripe Products, Prices, Customers,
-- Subscriptions, and invoice status without touching patient/shop Stripe flows.

ALTER TABLE "resupply"."billing_plans"
  ADD COLUMN IF NOT EXISTS "stripe_product_id" text,
  ADD COLUMN IF NOT EXISTS "stripe_price_id" text,
  ADD COLUMN IF NOT EXISTS "stripe_synced_at" timestamp with time zone;

ALTER TABLE "resupply"."billing_addons"
  ADD COLUMN IF NOT EXISTS "stripe_product_id" text,
  ADD COLUMN IF NOT EXISTS "stripe_price_id" text,
  ADD COLUMN IF NOT EXISTS "stripe_synced_at" timestamp with time zone;

ALTER TABLE "resupply"."tenant_billing_subscriptions"
  ADD COLUMN IF NOT EXISTS "stripe_customer_id" text,
  ADD COLUMN IF NOT EXISTS "stripe_subscription_id" text,
  ADD COLUMN IF NOT EXISTS "stripe_status" text,
  ADD COLUMN IF NOT EXISTS "stripe_last_synced_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "current_period_start" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "current_period_end" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_invoice_id" text,
  ADD COLUMN IF NOT EXISTS "last_invoice_status" text;

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_billing_subscriptions_stripe_subscription_uidx"
  ON "resupply"."tenant_billing_subscriptions" ("stripe_subscription_id")
  WHERE "stripe_subscription_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "tenant_billing_subscriptions_stripe_customer_idx"
  ON "resupply"."tenant_billing_subscriptions" ("stripe_customer_id")
  WHERE "stripe_customer_id" IS NOT NULL;
