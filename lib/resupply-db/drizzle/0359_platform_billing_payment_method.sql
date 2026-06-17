-- 0359_platform_billing_payment_method — Tenant Stripe payment method readiness.
--
-- Checkout setup sessions and Billing Portal updates happen on Stripe-hosted
-- pages. Mirror the default payment method summary onto the active tenant
-- billing subscription so admins can see whether a tenant is ready to collect.

ALTER TABLE "resupply"."tenant_billing_subscriptions"
  ADD COLUMN IF NOT EXISTS "stripe_default_payment_method_id" text,
  ADD COLUMN IF NOT EXISTS "stripe_payment_method_type" text,
  ADD COLUMN IF NOT EXISTS "stripe_payment_method_brand" text,
  ADD COLUMN IF NOT EXISTS "stripe_payment_method_last4" text,
  ADD COLUMN IF NOT EXISTS "stripe_payment_method_updated_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "tenant_billing_subscriptions_stripe_payment_method_idx"
  ON "resupply"."tenant_billing_subscriptions" ("stripe_default_payment_method_id")
  WHERE "stripe_default_payment_method_id" IS NOT NULL;
