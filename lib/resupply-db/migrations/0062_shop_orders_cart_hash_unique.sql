-- Migration 0062: Partial unique index on shop_orders.cart_hash (D-13).
-- Prevents two concurrent checkout requests with an identical cart from
-- both inserting rows (bypassing application-layer deduplication).
--
-- Partial (WHERE cart_hash IS NOT NULL) because guest checkouts and
-- legacy rows have no cart_hash. PostgreSQL UNIQUE treats NULLs as
-- distinct anyway, but the partial filter keeps the index small.
--
-- Drizzle-kit cannot express partial unique indexes; this migration is
-- the source of truth. The schema column comment references this migration.

CREATE UNIQUE INDEX "shop_orders_cart_hash_unique_idx"
  ON "resupply"."shop_orders" ("cart_hash")
  WHERE "cart_hash" IS NOT NULL;
