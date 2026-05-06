-- Migration 0058: DB-level CHECK constraints on status columns for
-- shop_returns and shop_orders. shop_reviews already has its constraint
-- (migration 0052). These guards complement the Drizzle TS enums added
-- in the corresponding schema files.

ALTER TABLE resupply.shop_returns
  ADD CONSTRAINT shop_returns_status_enum
  CHECK (status IN (
    'requested',
    'approved',
    'rejected',
    'shipped_back',
    'received',
    'refunded',
    'replaced',
    'closed'
  ));

ALTER TABLE resupply.shop_orders
  ADD CONSTRAINT shop_orders_status_enum
  CHECK (status IN (
    'pending',
    'paid',
    'refunded',
    'expired',
    'failed'
  ));
