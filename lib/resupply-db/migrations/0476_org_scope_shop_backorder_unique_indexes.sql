-- Org-scope the shop_backorders / shop_sku_substitutes unique indexes.
--
-- 0090 created two UNIQUE indexes keyed only on the (tenant-agnostic) SKU
-- strings:
--   * shop_backorders_active_sku_idx        UNIQUE (sku) WHERE cleared_at IS NULL
--   * shop_sku_substitutes_primary_alt_unique UNIQUE (primary_sku, alternative_sku)
-- 0341 later added org_id to both tables but never re-scoped these indexes.
-- Because SKUs recur across tenants, once tenant A has an ACTIVE backorder on
-- SKU 'AF20-S' (or a substitute pair), tenant B marking the SAME SKU hits a
-- 23505 unique-violation — tenant B literally cannot record a backorder /
-- substitute for a SKU string A happens to share. Re-create both indexes with
-- org_id leading so uniqueness is per-tenant.
--
-- Safe to apply: the OLD indexes are STRICTLY stronger (global-unique on the
-- SKU) than the new per-tenant ones, so all existing rows already satisfy the
-- new (org_id, …) uniqueness — the CREATE cannot fail on current data. org_id
-- is populated on both tables (0341). Idempotent: DROP IF EXISTS + CREATE
-- UNIQUE INDEX IF NOT EXISTS. Plain (non-CONCURRENTLY) so it runs inside the
-- migrator's transaction.

DROP INDEX IF EXISTS "resupply"."shop_backorders_active_sku_idx";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "shop_backorders_active_org_sku_idx"
  ON "resupply"."shop_backorders" ("org_id", "sku")
  WHERE cleared_at IS NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS "resupply"."shop_sku_substitutes_primary_alt_unique";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "shop_sku_substitutes_org_primary_alt_unique"
  ON "resupply"."shop_sku_substitutes" ("org_id", "primary_sku", "alternative_sku");
