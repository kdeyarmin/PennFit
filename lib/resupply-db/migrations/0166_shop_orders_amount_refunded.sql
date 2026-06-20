-- Track cumulative refund amount on shop_orders so partial refunds
-- don't have to flip the entire row to status='refunded'. Previously
-- markStatusByPaymentIntent wrote status='refunded' on ANY
-- charge.refunded event regardless of partial-vs-full, which made the
-- order disappear from /shop/me/orders, blocked the return flow
-- (my-returns.ts:122 rejects non-paid), and silently downgraded paid
-- partial-refund orders.
--
-- After this migration:
--   * Partial refunds: status stays "paid", amount_refunded_cents is
--     bumped; UI can show "$X refunded of $Y".
--   * Full refunds (amount_refunded == amount_total_cents): status
--     flips to "refunded" as before.

ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "amount_refunded_cents" bigint NOT NULL DEFAULT 0;
