-- 0405_product_ship_specs — per-product parcel presets for XPS shipping labels
--
-- WHY
--   Creating an XPS label needs a parcel weight (and ideally dimensions).
--   Re-entering the same weight for every order of the same product is
--   busywork and error-prone. This table stores a per-product default so
--   the Shipping page can pre-fill the parcel from the order's line items
--   (summing each product's preset × quantity), and the batch / auto-resolve
--   paths can run unattended.
--
-- WHAT
--   Tenant-scoped (each DME ships its own catalog), keyed by the Stripe
--   product id that shop_order_items already carries, so an order's parcel
--   resolves with a single join. weight_oz is required; dimensions optional.
--
-- No PHI — this is product reference data the operator maintains.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

CREATE TABLE IF NOT EXISTS "resupply"."product_ship_specs" (
  "org_id" uuid NOT NULL REFERENCES "resupply"."organizations"("id"),
  -- The Stripe product id carried on shop_order_items.product_id.
  "product_id" text NOT NULL,
  -- Default parcel weight for one unit of this product, in ounces.
  "weight_oz" numeric NOT NULL CHECK ("weight_oz" > 0),
  -- Optional default dimensions (inches).
  "length_in" numeric CHECK ("length_in" IS NULL OR "length_in" > 0),
  "width_in" numeric CHECK ("width_in" IS NULL OR "width_in" > 0),
  "height_in" numeric CHECK ("height_in" IS NULL OR "height_in" > 0),
  -- Optional human label so the presets editor can show something friendlier
  -- than a Stripe id (order items don't persist a title).
  "label" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "product_ship_specs_pkey" PRIMARY KEY ("org_id", "product_id")
);
--> statement-breakpoint

-- Defense-in-depth RLS (mirrors product_costs 0357). service_role (the
-- runtime path) bypasses it; the per-tenant policy is the backstop for the
-- day access moves to a non-bypassing role.
ALTER TABLE "resupply"."product_ship_specs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "resupply"."product_ship_specs";
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "resupply"."product_ship_specs"
  USING ("org_id" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint

-- Grant the Supabase data-API roles access (service_role reads/writes the
-- runtime path; anon/authenticated read via the RLS-scoped view).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT SELECT ON "resupply"."product_ship_specs" TO anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON "resupply"."product_ship_specs" TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "resupply"."product_ship_specs" TO service_role;
  END IF;
END
$$;
