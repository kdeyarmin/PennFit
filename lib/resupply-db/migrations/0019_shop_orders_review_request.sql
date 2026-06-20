-- shop_orders.review_request_sent_at — one-shot timestamp marking
-- when the post-purchase review-request email went out for this
-- order. Set by the dispatcher; read by both the dispatcher
-- (suppress duplicates) and ops analytics ("how many requests have
-- we sent in the last 30 days?").
--
-- Why a per-order column rather than per-customer:
--   Patients reorder regularly. Each order is a fresh prompt to
--   leave a review. Attribution is per-order in our reviews schema
--   already (verified-purchaser badge), so following the same grain
--   keeps the queries simple.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "review_request_sent_at" timestamp with time zone;
