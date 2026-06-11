-- shop_backorders + shop_sku_substitutes + fulfillments.substituted_from_sku
-- Backorder substitution for the resupply order-flow.
-- See lib/resupply-db/src/schema/shop-backorders.ts and
-- shop-sku-substitutes.ts for the full lookup contract.
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

CREATE TABLE IF NOT EXISTS "resupply"."shop_backorders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "sku" varchar(64) NOT NULL,
  "marked_at" timestamp with time zone NOT NULL DEFAULT now(),
  "cleared_at" timestamp with time zone,
  "notes" text,
  "marked_by_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- At most one ACTIVE backorder per sku. Cleared rows stack up for
-- audit history.
CREATE UNIQUE INDEX IF NOT EXISTS "shop_backorders_active_sku_idx"
  ON "resupply"."shop_backorders" ("sku")
  WHERE cleared_at IS NULL;

CREATE TABLE IF NOT EXISTS "resupply"."shop_sku_substitutes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "primary_sku" varchar(64) NOT NULL,
  "alternative_sku" varchar(64) NOT NULL,
  "priority" integer NOT NULL DEFAULT 100,
  "notes" text,
  "active" boolean NOT NULL DEFAULT true,
  "created_by_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "shop_sku_substitutes_primary_alt_unique"
  ON "resupply"."shop_sku_substitutes" ("primary_sku", "alternative_sku");

CREATE INDEX IF NOT EXISTS "shop_sku_substitutes_primary_sort_idx"
  ON "resupply"."shop_sku_substitutes" ("primary_sku", "priority");

ALTER TABLE "resupply"."fulfillments"
  ADD COLUMN IF NOT EXISTS "substituted_from_sku" text;
