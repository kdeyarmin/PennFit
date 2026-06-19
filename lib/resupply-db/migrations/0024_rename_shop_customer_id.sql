-- 0024_rename_shop_customer_id — rename the legacy `clerk_user_id`
-- column on every shop_* table to `customer_id`.
--
-- Stage 5d.3 of the Clerk → in-house migration. After Stage 4c
-- the values stored in `clerk_user_id` no longer have any Clerk
-- semantics — they're opaque shop-customer ids minted from
-- `auth.users.id`. The column name is the last bit of dead-Clerk
-- naming that survived the cutover; this migration retires it.
--
-- No data conversion, no FK reshuffling: the seven shop tables
-- never carried a SQL-level foreign key on `clerk_user_id` (the
-- `shop_customers` row is the join target, but child rows
-- reference it by value, not by `REFERENCES`). All we do is
-- ALTER TABLE ... RENAME COLUMN, plus rename the indexes whose
-- auto-generated names embed the old column name. Postgres keeps
-- the index data intact across an `ALTER INDEX ... RENAME TO`.
--
-- Touched tables:
--   * shop_customers           (PK column)
--   * shop_orders              + shop_orders_clerk_user_id_idx
--   * shop_order_items         + shop_order_items_clerk_user_id_product_id_idx
--   * shop_subscriptions       + shop_subscriptions_clerk_user_id_idx
--   * shop_reviews             + shop_reviews_clerk_user_id_product_id_unique
--   * shop_returns             + shop_returns_clerk_user_id_idx
--   * shop_abandoned_carts     + named UNIQUE constraint (from 0008)
--                                shop_abandoned_carts_clerk_user_id_unique
--
-- Reversibility: this migration is purely a rename — to roll
-- back, swap every `customer_id` for `clerk_user_id` in the
-- inverse direction.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."shop_customers"
  RENAME COLUMN "clerk_user_id" TO "customer_id";

ALTER TABLE "resupply"."shop_orders"
  RENAME COLUMN "clerk_user_id" TO "customer_id";
ALTER INDEX "resupply"."shop_orders_clerk_user_id_idx"
  RENAME TO "shop_orders_customer_id_idx";

ALTER TABLE "resupply"."shop_order_items"
  RENAME COLUMN "clerk_user_id" TO "customer_id";
ALTER INDEX "resupply"."shop_order_items_clerk_user_id_product_id_idx"
  RENAME TO "shop_order_items_customer_id_product_id_idx";

ALTER TABLE "resupply"."shop_subscriptions"
  RENAME COLUMN "clerk_user_id" TO "customer_id";
ALTER INDEX "resupply"."shop_subscriptions_clerk_user_id_idx"
  RENAME TO "shop_subscriptions_customer_id_idx";

ALTER TABLE "resupply"."shop_reviews"
  RENAME COLUMN "clerk_user_id" TO "customer_id";
ALTER INDEX "resupply"."shop_reviews_clerk_user_id_product_id_unique"
  RENAME TO "shop_reviews_customer_id_product_id_unique";

ALTER TABLE "resupply"."shop_returns"
  RENAME COLUMN "clerk_user_id" TO "customer_id";
ALTER INDEX "resupply"."shop_returns_clerk_user_id_idx"
  RENAME TO "shop_returns_customer_id_idx";

ALTER TABLE "resupply"."shop_abandoned_carts"
  RENAME COLUMN "clerk_user_id" TO "customer_id";
-- The UNIQUE constraint on this column was created with an
-- explicit `_unique` suffix in 0008, not the auto `_key` form.
-- Rename it for symmetry with the new column name.
ALTER INDEX "resupply"."shop_abandoned_carts_clerk_user_id_unique"
  RENAME TO "shop_abandoned_carts_customer_id_unique";
