-- Adds shipment-tracking columns to shop_orders (Admin Phase 4 / W3 T-C6).
--
-- Why these are SEPARATE columns rather than overloading `status`:
--   `status` tracks the PAYMENT lifecycle:
--     pending → paid → expired/refunded
--   Physical fulfillment is orthogonal: a paid order can sit at
--   "awaiting shipment", "shipped", or "delivered" without ever
--   changing its payment status. Modeling fulfillment as its own
--   columns keeps the existing payment-status filters working
--   unchanged (every shop endpoint that filters `status='paid'`
--   today continues to surface shipped + delivered orders) and
--   lets the new admin "awaiting shipment" queue express its
--   filter cleanly:
--     WHERE status = 'paid' AND shipped_at IS NULL
--   "Delivered" is a derived state (`delivered_at IS NOT NULL`),
--   and a later refund (`status='refunded'`) preserves the
--   shipped_at / delivered_at history for support and analytics.
--
-- All four columns are nullable additive — pre-existing paid orders
-- have NULL across the board until an admin enters tracking. No
-- backfill is needed; the column defaults itself produce the
-- "fulfillment hasn't been entered yet" state.
--
-- The supporting index is PARTIAL (rows where shipped_at IS NULL),
-- so the index size is bounded by the operational backlog rather
-- than the full order history (which monotonically grows). This
-- powers the high-frequency admin "what do I need to ship?" query
-- without paying for index bloat on shipped historical rows.
--
-- Per ADR 003 — versioned hand-authored migration; this codebase
-- does not use db:push because db:push silently rewrites columns
-- once PHI lands.
--
-- ─────────────────────────────────────────────────────────────────
-- HISTORICAL BACKFILL: shop_orders + shop_customers.
--
-- Both tables exist in the live DB (the cash-pay shop has been
-- shipping for two phases) but were originally created by an early
-- `drizzle-kit push` before this codebase committed to ADR 003.
-- They never received a migration of their own. The CREATE TABLE
-- IF NOT EXISTS / CREATE INDEX IF NOT EXISTS blocks below are pure
-- no-ops on the production database (every column and index already
-- exists) and serve only to make the migration history self-
-- contained for fresh databases (the readiness integration test
-- provisions a throwaway DB and replays the full migration set).
--
-- The column shapes here are the EXACT pre-tracking schema (no
-- shipping_address / tracking_carrier / tracking_number / shipped_at /
-- delivered_at). Those are added by the ALTER blocks at the bottom
-- of THIS migration (and shipping_address by 0014), so the resulting
-- table converges to today's schema regardless of where the database
-- is starting from.
--
-- Drizzle's migrator gates re-execution on `folderMillis` (the
-- journal `when`) rather than file content hash — see
-- node_modules/drizzle-orm/pg-core/dialect.js#migrate. Adding these
-- backfill statements to a previously-applied migration file is
-- therefore safe: the live DB has already passed this migration's
-- folderMillis and will not re-run it.
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "resupply"."shop_customers" (
  "clerk_user_id" text PRIMARY KEY NOT NULL,
  "stripe_customer_id" text,
  "display_name" text,
  "email_lower" text,
  "shipping_address_json" jsonb,
  "default_payment_method_id" text,
  "default_payment_method_brand" text,
  "default_payment_method_last4" text,
  "default_payment_method_exp_month" integer,
  "default_payment_method_exp_year" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "shop_customers_stripe_customer_id_unique" UNIQUE ("stripe_customer_id")
);

CREATE INDEX IF NOT EXISTS "shop_customers_email_lower_idx"
  ON "resupply"."shop_customers" ("email_lower");

CREATE TABLE IF NOT EXISTS "resupply"."shop_orders" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid()::text) NOT NULL,
  "stripe_session_id" text NOT NULL,
  "stripe_payment_intent_id" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "amount_total_cents" integer,
  "currency" text,
  "cart_hash" text,
  "clerk_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "paid_at" timestamp with time zone,
  CONSTRAINT "shop_orders_stripe_session_id_unique" UNIQUE ("stripe_session_id")
);

CREATE INDEX IF NOT EXISTS "shop_orders_status_idx"
  ON "resupply"."shop_orders" ("status");

CREATE INDEX IF NOT EXISTS "shop_orders_created_at_idx"
  ON "resupply"."shop_orders" ("created_at");

CREATE INDEX IF NOT EXISTS "shop_orders_clerk_user_id_idx"
  ON "resupply"."shop_orders" ("clerk_user_id");

-- ─────────────────────────────────────────────────────────────────
-- T-C6 additive columns + partial "awaiting shipment" index.
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "tracking_carrier" text;

ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "tracking_number" text;

ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "shipped_at" timestamp with time zone;

ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "delivered_at" timestamp with time zone;

-- Powers the admin "awaiting shipment" queue. Partial so the
-- index only covers operationally-pending rows.
CREATE INDEX IF NOT EXISTS "shop_orders_awaiting_shipment_idx"
  ON "resupply"."shop_orders" ("paid_at" DESC)
  WHERE "shipped_at" IS NULL;
