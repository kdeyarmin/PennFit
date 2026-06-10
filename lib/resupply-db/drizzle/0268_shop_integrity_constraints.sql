-- D-04: Partial unique constraint on shop_returns — prevents double refunds
-- from a race condition creating two return rows for the same order.
-- We allow multiple rows in terminal statuses (cancelled / closed) so
-- historical re-opens remain possible, but only one active return per order.
--
-- D-05: Check constraint on shop_orders.amount_total_cents — prevents
-- application bugs that calculate negative totals from being persisted.
--
-- Per ADR 003 — versioned hand-authored migration.

-- D-04
CREATE UNIQUE INDEX "shop_returns_one_active_per_order_idx"
  ON "resupply"."shop_returns" ("order_id")
  WHERE "status" NOT IN ('closed');

-- D-05
ALTER TABLE "resupply"."shop_orders"
  ADD CONSTRAINT "shop_orders_amount_total_cents_non_negative"
  CHECK ("amount_total_cents" IS NULL OR "amount_total_cents" >= 0);
