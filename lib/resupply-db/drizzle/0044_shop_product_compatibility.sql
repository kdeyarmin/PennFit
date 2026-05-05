-- shop_product_compatibility — maps Stripe product IDs to the
-- CPAP machines they're compatible with (Phase B.3 / feature #11).
--
-- Mental model:
--   * A row says "product X is compatible with this manufacturer
--     (and optionally this specific model)".
--   * Multiple rows per product mean "compatible with multiple
--     machines" (a mask cushion that fits both AirSense 11 and
--     AirSense 10, for example).
--   * Products with NO rows are treated as "universal" by the
--     filter — wipes, alcohol-free cleaning supplies, batteries,
--     storage cases, etc. The lookup endpoint includes these in
--     every machine's compatible-products list.
--   * `machine_model` is nullable; null means "every model from
--     this manufacturer". A row (ResMed, NULL) matches AirSense 10
--     AND AirSense 11 AND any future ResMed model.
--
-- We intentionally don't make product_id a foreign key — Stripe is
-- the catalog source of truth and product IDs can outlive a
-- temporary local mirror.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."shop_product_compatibility" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "product_id" text NOT NULL,
  "machine_manufacturer" text NOT NULL,
  "machine_model" text,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- One row per (product, manufacturer, model) tuple. Postgres
  -- treats NULL as distinct in UNIQUE constraints, which is what
  -- we want — multiple rows with model=NULL for the same product
  -- would be redundant but not catastrophic, and a partial unique
  -- on null-model is overkill for this volume.
  CONSTRAINT "shop_product_compatibility_unique"
    UNIQUE ("product_id", "machine_manufacturer", "machine_model")
);

-- Lookup-by-product: "what machines is this product compatible with"
CREATE INDEX IF NOT EXISTS "shop_product_compatibility_product_idx"
  ON "resupply"."shop_product_compatibility" ("product_id");

-- Lookup-by-machine: "what products work with this manufacturer"
CREATE INDEX IF NOT EXISTS "shop_product_compatibility_manufacturer_idx"
  ON "resupply"."shop_product_compatibility" ("machine_manufacturer");
