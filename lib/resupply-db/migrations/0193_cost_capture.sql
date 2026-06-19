-- 0193_cost_capture — Phase 0 / F1: cost & COGS capture foundation.
-- (Renumbered from 0186 → 0193: main landed 0186_reconcile_prod_column_drift
--  while this branch was open, so the original prefix collided.)
--
-- Why this exists
-- ---------------
-- Every owner-facing financial metric on the roadmap (gross-margin
-- dashboard, payer-mix profitability, LTV, inventory turnover, the
-- cash-flow forecast — see docs/feature-roadmap-2026-05-31.md) is
-- blocked on a single missing number: what a unit COST us. Revenue,
-- refunds, and allowed/paid amounts are all captured today; cost is
-- recorded nowhere.
--
-- This migration lays the data foundation. The read/write wiring lands
-- in follow-up commits in the same phase; nothing reads these columns
-- yet, so this is purely additive:
--
--   * resupply.product_costs — the CURRENT unit cost per shop SKU.
--     One row per SKU (natural PK). Re-costing UPDATEs the row; the
--     point-in-time record lives on the per-transaction snapshot
--     columns below, so this table only ever answers "what does SKU X
--     cost us right now?".
--
--   * Cost-SNAPSHOT columns on the two places a unit is sold:
--       - shop_order_items            (cash / storefront sales)
--       - insurance_claim_line_items  (insurance-billed dispenses)
--     Stamped at row-creation time from product_costs so a later cost
--     change never rewrites the margin of a historical order. Nullable:
--     historical rows + any SKU without a recorded cost read back as
--     "cost unknown", surfaced honestly rather than silently treated as
--     zero (which would inflate margin to 100%).
--
--   * Order-level fee columns on shop_orders (Stripe processing fee,
--     shipping cost) so contribution margin can subtract the real
--     cost-to-sell, not just COGS.
--
-- Additive and non-breaking: every column is nullable or IF NOT EXISTS,
-- the new table is seeded by nothing here, and no code path reads these
-- yet. Per ADR 003 — versioned hand-authored migration.

-- ---------------------------------------------------------------
-- product_costs — current unit cost per shop SKU.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply"."product_costs" (
  -- The shop SKU this cost applies to. Matches the `shop_sku` the
  -- Stripe catalog seed (scripts/src/seed-stripe-products.ts) writes
  -- into product metadata. Natural primary key — one cost per SKU.
  "sku" text PRIMARY KEY NOT NULL,
  -- Our landed unit cost, in integer cents. This is COGS, NOT a price.
  "unit_cost_cents" integer NOT NULL,
  "currency" text NOT NULL DEFAULT 'usd',
  -- Where the number came from, for auditing a margin later.
  "cost_source" text NOT NULL DEFAULT 'manual',
  -- When this cost took effect (informational; the live row is the
  -- current cost regardless of this value).
  "effective_from" timestamp with time zone DEFAULT now() NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "resupply"."product_costs"
  DROP CONSTRAINT IF EXISTS "product_costs_cost_source_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."product_costs"
  ADD CONSTRAINT "product_costs_cost_source_enum"
  CHECK ("cost_source" IN ('manual', 'invoice', 'catalog', 'estimate'));
--> statement-breakpoint

ALTER TABLE "resupply"."product_costs"
  DROP CONSTRAINT IF EXISTS "product_costs_unit_cost_nonneg";
--> statement-breakpoint
ALTER TABLE "resupply"."product_costs"
  ADD CONSTRAINT "product_costs_unit_cost_nonneg"
  CHECK ("unit_cost_cents" >= 0);
--> statement-breakpoint

-- RLS — match the deny-all posture established in 0169/0170 for every
-- resupply table. service_role (the only runtime data path) bypasses
-- RLS; enabling it with no policy makes the table deny-all to
-- anon/authenticated, which is the intended end-state.
ALTER TABLE "resupply"."product_costs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- Cost snapshot on storefront / cash sales.
-- Stamped at order-item creation from product_costs; nullable so a
-- missing cost reads as "unknown" (never silently zero). integer to
-- match the existing unit_amount_cents column on this table.
-- ---------------------------------------------------------------
ALTER TABLE "resupply"."shop_order_items"
  ADD COLUMN IF NOT EXISTS "unit_cost_cents" integer;
--> statement-breakpoint
ALTER TABLE "resupply"."shop_order_items"
  ADD COLUMN IF NOT EXISTS "cost_source" text;
--> statement-breakpoint
ALTER TABLE "resupply"."shop_order_items"
  ADD COLUMN IF NOT EXISTS "cost_captured_at" timestamp with time zone;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- Cost snapshot on insurance-billed dispenses.
-- bigint to match the existing *_cents columns on this table.
-- ---------------------------------------------------------------
ALTER TABLE "resupply"."insurance_claim_line_items"
  ADD COLUMN IF NOT EXISTS "unit_cost_cents" bigint;
--> statement-breakpoint
ALTER TABLE "resupply"."insurance_claim_line_items"
  ADD COLUMN IF NOT EXISTS "cost_source" text;
--> statement-breakpoint
ALTER TABLE "resupply"."insurance_claim_line_items"
  ADD COLUMN IF NOT EXISTS "cost_captured_at" timestamp with time zone;
--> statement-breakpoint

-- ---------------------------------------------------------------
-- Order-level cost-to-sell fees, for true contribution margin.
-- ---------------------------------------------------------------
ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "stripe_fee_cents" integer;
--> statement-breakpoint
ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "shipping_cost_cents" integer;
