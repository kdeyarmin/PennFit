-- Migration 0404 — XPS Ship label fields on shop_orders
--
-- Backs the XPS Ship shipping-label integration. The existing
-- tracking_carrier / tracking_number / shipped_at columns (migration
-- 0013) still hold the customer-facing tracking shown on the track-order
-- page; these new columns capture the XPS-side booking metadata so the
-- label can be re-fetched and the booked cost reported, and so an order
-- that has only been STAGED in XPS (Put Order succeeded but the shipment
-- has not been processed/booked yet) can be resolved later.
--
--   xps_book_number       text
--     The XPS shipment "bookNumber" — the lookup key for Retrieve
--     Shipment + Retrieve Shipping Label. NULL until the staged order is
--     processed into a booked shipment.
--
--   xps_label_status      text CHECK (... IN ('staged','booked','voided'))
--     'staged' — Put Order succeeded; awaiting XPS processing/booking.
--     'booked' — shipment resolved (book number + tracking on file).
--     'voided' — the staged order / label was cancelled.
--     NULL     — no XPS label has ever been requested for this order.
--
--   shipping_service_code text
--     The chosen carrier service (e.g. "ups_ground") as reported by XPS.
--
-- The booked label cost is written to the EXISTING shipping_cost_cents
-- column (migration 0193, already the order's ship cost for margin), so
-- this migration does not add it.

ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "xps_book_number" text;
--> statement-breakpoint
ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "xps_label_status" text
    CHECK ("xps_label_status" IN ('staged', 'booked', 'voided'));
--> statement-breakpoint
ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "shipping_service_code" text;
--> statement-breakpoint

-- Partial index: the "staged in XPS but not yet booked" worklist the
-- sync job / admin queue polls to resolve pending labels.
CREATE INDEX IF NOT EXISTS "shop_orders_xps_staged_idx"
  ON "resupply"."shop_orders" ("created_at")
  WHERE "xps_label_status" = 'staged';
--> statement-breakpoint

-- Grant column-level access to the Supabase data-API roles, matching the
-- pattern used by the patient-column migrations. service_role (the
-- runtime data path) needs SELECT + UPDATE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT SELECT (xps_book_number, xps_label_status, shipping_service_code)
      ON "resupply"."shop_orders" TO anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT (xps_book_number, xps_label_status, shipping_service_code)
      ON "resupply"."shop_orders" TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, UPDATE (xps_book_number, xps_label_status, shipping_service_code)
      ON "resupply"."shop_orders" TO service_role;
  END IF;
END
$$;
