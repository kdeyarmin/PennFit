-- 0383_platform_billing_stripe_account_ref — track which Stripe ACCOUNT
-- each synced platform-billing object belongs to.
--
-- Stripe object IDs (products, prices, customers, subscriptions) are
-- account-scoped. When an operator moves platform SaaS billing onto a
-- DEDICATED Stripe account (STRIPE_PLATFORM_SECRET_KEY), IDs synced earlier
-- on the shared (patient-checkout) account become invalid against the new
-- account. Recording the owning account id lets the sync detect the switch:
-- catalog objects (products/prices) are recreated on the new account, while
-- tenant customers/subscriptions FAIL LOUDLY (never silently recreated —
-- the old account's subscription may still be charging the card).
--
-- A NULL ref means "synced before this column existed" — i.e. on the shared
-- account, since dedicated mode didn't exist yet. The sync treats NULL as
-- the shared account for the match check.

ALTER TABLE "resupply"."billing_plans"
  ADD COLUMN IF NOT EXISTS "stripe_account_ref" text;

ALTER TABLE "resupply"."billing_addons"
  ADD COLUMN IF NOT EXISTS "stripe_account_ref" text;

ALTER TABLE "resupply"."tenant_billing_subscriptions"
  ADD COLUMN IF NOT EXISTS "stripe_account_ref" text;
