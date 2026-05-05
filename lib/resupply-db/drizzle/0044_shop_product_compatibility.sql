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
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Enforce semantic uniqueness the same way the read path matches:
-- manufacturer/model are case-insensitive, and machine_model=NULL
-- is its own compatibility identity meaning "all models from this
-- manufacturer". We split null-model and non-null-model rows into
-- separate partial unique indexes so duplicate "manufacturer-wide"
-- rows are blocked without relying on sentinel values.
CREATE UNIQUE INDEX IF NOT EXISTS
  "shop_product_compatibility_unique_null_model_idx"
  ON "resupply"."shop_product_compatibility" (
    "product_id",
    lower("machine_manufacturer")
  )
  WHERE "machine_model" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
  "shop_product_compatibility_unique_model_idx"
  ON "resupply"."shop_product_compatibility" (
    "product_id",
    lower("machine_manufacturer"),
    lower("machine_model")
  )
  WHERE "machine_model" IS NOT NULL;

-- Lookup-by-product: "what machines is this product compatible with"
CREATE INDEX IF NOT EXISTS "shop_product_compatibility_product_idx"
  ON "resupply"."shop_product_compatibility" ("product_id");

-- Lookup-by-machine: case-insensitive manufacturer/model matching
-- for the public compatibility lookup. Using lower(...) here keeps
-- the index usable when the WHERE clause normalizes both fields.
CREATE INDEX IF NOT EXISTS "shop_product_compatibility_manufacturer_model_lower_idx"
  ON "resupply"."shop_product_compatibility" (
    lower("machine_manufacturer"),
    lower("machine_model")
  );
