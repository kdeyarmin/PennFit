-- 0432_shop_orders_tracking_number_idx — index the carrier-tracking lookup.
--
-- The carrier-tracking webhook (artifacts/resupply-api/src/lib/shipping/
-- carrier-tracking.ts) resolves an inbound EasyPost/Shippo push to its order
-- with an UNSCOPED equality lookup on shop_orders.tracking_number (a carrier
-- push carries no tenant context, and tracking numbers are globally unique).
-- Migration 0013 added the column but no index, so as order volume grows each
-- webhook delivery would degrade into a sequential scan of shop_orders. This
-- adds a partial b-tree index on the column.
--
-- Partial (WHERE tracking_number IS NOT NULL): most rows carry no tracking
-- number until the order ships, so the partial index stays small and only
-- covers the rows the lookup can actually match. Idempotent (IF NOT EXISTS)
-- so a re-run is a no-op. No CONCURRENTLY — the migrator wraps each file in a
-- transaction (matching the existing index migrations, e.g. 0431).

CREATE INDEX IF NOT EXISTS "shop_orders_tracking_number_idx"
  ON "resupply"."shop_orders" ("tracking_number")
  WHERE "tracking_number" IS NOT NULL;
