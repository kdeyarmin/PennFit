-- Webhook idempotency hardening for shop_order_items.
--
-- Original 0010 declared price_id as nullable text + a UNIQUE on
-- (stripe_session_id, product_id, price_id). PostgreSQL UNIQUE
-- treats NULLs as distinct, so two rows with the same session +
-- product but a NULL price_id would BOTH be inserted on a Stripe
-- webhook redelivery — defeating the dedupe contract.
--
-- We don't actually need NULL semantics here: every paid Stripe
-- Checkout Session line item carries a price.id (li_xxx → price_xxx
-- mapping). The nullable column was a defensive choice for
-- hypothetical "deleted price on legacy session" cases that, in
-- practice, the webhook handler skips upstream (we already require
-- a productId before inserting; a missing price is rare enough that
-- '' is a safe sentinel that keeps the UNIQUE working).
--
-- Safe additive change:
--   1. Backfill any NULL → '' (table just shipped this Phase, so
--      production has at most a handful of rows in dev/preview).
--   2. Set DEFAULT ''  so future inserts that omit the column
--      (none today, but future-proof).
--   3. Add NOT NULL constraint — this is a CONSTRAINT change, not
--      a column TYPE change, so no destructive ALTER.
--   4. The UNIQUE INDEX from 0010 keeps working unchanged; with
--      no NULLs possible, ON CONFLICT DO NOTHING now actually
--      dedupes redeliveries.
--
-- Per ADR 003 — versioned hand-authored migration; this codebase
-- does not use db:push because db:push silently rewrites columns
-- once PHI lands.
UPDATE "resupply"."shop_order_items"
  SET "price_id" = ''
  WHERE "price_id" IS NULL;

ALTER TABLE "resupply"."shop_order_items"
  ALTER COLUMN "price_id" SET DEFAULT '';

ALTER TABLE "resupply"."shop_order_items"
  ALTER COLUMN "price_id" SET NOT NULL;
