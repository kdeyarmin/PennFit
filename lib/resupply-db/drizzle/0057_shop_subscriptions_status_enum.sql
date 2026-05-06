-- Migration 0057: Add CHECK constraint on shop_subscriptions.status to enforce
-- the known Stripe subscription status values. The column is populated verbatim
-- from Stripe webhook events; this guard rejects any value outside the known set
-- at the DB layer, complementing the Drizzle TS enum.

ALTER TABLE resupply.shop_subscriptions
  ADD CONSTRAINT shop_subscriptions_status_enum
  CHECK (status IN (
    'active',
    'past_due',
    'unpaid',
    'canceled',
    'incomplete',
    'incomplete_expired',
    'trialing',
    'paused'
  ));
