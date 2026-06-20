-- Local mirror of paid Stripe Checkout Session line items.
--
-- Populated by the Stripe webhook handler when a checkout.session
-- moves to `paid` (it fetches the Session's line_items and upserts
-- each one here). The companion shop_orders row already exists by
-- this point — see lib/resupply-db/src/schema/shop-order-items.ts
-- for the full rationale (verified-purchaser badge + order-history
-- rendering without per-row Stripe round trips).
--
-- Webhook idempotency is enforced by a UNIQUE on
-- (stripe_session_id, product_id, price_id) so a Stripe redelivery
-- (or the planned async_payment_succeeded shadow) absorbs cleanly
-- via ON CONFLICT DO NOTHING.
--
-- Pure additive change (CREATE TABLE only). Matches ADR 003 — this
-- codebase uses versioned hand-authored migrations because db:push
-- silently rewrites columns once PHI lands.
CREATE TABLE "resupply"."shop_order_items" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid()::text) NOT NULL,
  "order_id" text NOT NULL,
  "stripe_session_id" text NOT NULL,
  "clerk_user_id" text,
  "product_id" text NOT NULL,
  "price_id" text,
  "quantity" integer NOT NULL,
  "unit_amount_cents" integer,
  "currency" text,
  "paid_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "shop_order_items_session_product_price_unique"
  ON "resupply"."shop_order_items" ("stripe_session_id", "product_id", "price_id");

CREATE INDEX "shop_order_items_clerk_user_id_product_id_idx"
  ON "resupply"."shop_order_items" ("clerk_user_id", "product_id");

CREATE INDEX "shop_order_items_order_id_idx"
  ON "resupply"."shop_order_items" ("order_id");

CREATE INDEX "shop_order_items_product_id_idx"
  ON "resupply"."shop_order_items" ("product_id");
