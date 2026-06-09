-- 0249_shop_orders_pickup — in-store pickup as an alternative to
-- shipping for cash-pay shop orders.
--
-- Why
-- ---
-- PennPaps was ship-only. This adds a per-order fulfillment method so a
-- customer can choose, at checkout, to pick the order up at one of the
-- business locations (resupply.locations, migration 0235) instead of
-- having it shipped. A `pickup` order skips carrier/tracking entirely
-- and runs a parallel lifecycle:
--
--   ship   : paid → shipped_at (tracking) → delivered_at
--   pickup : paid → ready_for_pickup_at   → picked_up_at
--
-- Columns
-- -------
--   * fulfillment_method  — 'ship' (default, every existing row) or
--     'pickup'. CHECK-constrained.
--   * pickup_location_id  — which location the customer collects from.
--     FK to resupply.locations; ON DELETE SET NULL so retiring a branch
--     never orphans order history (the snapshot of where they picked up
--     is preserved in the customer's own email + receipt).
--   * ready_for_pickup_at — stamped when staff mark the order ready
--     (the pickup analogue of shipped_at).
--   * picked_up_at        — stamped when the customer collects (the
--     pickup analogue of delivered_at).
--   * ready_for_pickup_email_sent_at — idempotency gate for the
--     "ready for pickup" notification, mirroring shipping_email_sent_at.
--
-- Additive + defaulted → every existing row stays valid and ship-only.
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "fulfillment_method" text NOT NULL DEFAULT 'ship';
--> statement-breakpoint

ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "pickup_location_id" uuid
    REFERENCES "resupply"."locations"("id") ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "ready_for_pickup_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "picked_up_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "ready_for_pickup_email_sent_at"
    timestamp with time zone;
--> statement-breakpoint

-- Enum guard for the method. Wrapped so a re-run doesn't error on the
-- already-present constraint.
DO $$
BEGIN
  ALTER TABLE "resupply"."shop_orders"
    ADD CONSTRAINT "shop_orders_fulfillment_method_chk"
    CHECK ("fulfillment_method" IN ('ship', 'pickup'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- Admin pickup worklist: paid pickup orders not yet marked ready,
-- newest first. Mirrors shop_orders_awaiting_shipment_idx.
CREATE INDEX IF NOT EXISTS "shop_orders_awaiting_pickup_idx"
  ON "resupply"."shop_orders" ("paid_at" DESC)
  WHERE "fulfillment_method" = 'pickup' AND "ready_for_pickup_at" IS NULL;
--> statement-breakpoint

-- Seed the storefront pickup feature flag DISABLED. Pickup only surfaces
-- in checkout when an operator turns this on AND at least one active
-- location exists — so enabling in-store pickup is an explicit,
-- reversible decision. Keep in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts.
INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('storefront.pickup',
   false,
   'Offer in-store pickup as an alternative to shipping at checkout. Off by default. When on, customers can choose to collect a one-time order at any active business location (resupply.locations); the order then uses the ready-for-pickup / picked-up lifecycle instead of carrier tracking. Disabling hides the option for new checkouts; in-flight pickup orders are unaffected.',
   'Storefront')
ON CONFLICT (key) DO NOTHING;
